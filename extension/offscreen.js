// 백그라운드 처리 엔진(offscreen 문서). 한 번에 한 강의씩 받아쓰기·슬라이드 캡처를 하고 IndexedDB에 저장한다.
// offscreen 문서에서는 chrome.runtime만 쓸 수 있어 상태는 background로 메시지를 보내 기록한다.
import { createSource, loadContentInfo, openMp4, fetchWindow, decodeAudio16k, decodeKeyframes } from './src/core/media.js';
import { createSlideDetector, toJpeg } from './src/core/slides.js';
import { loadAsr, transcribe, releaseAsr } from './src/core/asr.js';
import { buildPack, groupBySlide } from './src/core/pack.js';
import { buildReport } from './src/core/report.js';
import * as store from './src/core/store.js';

const WINDOW = 120; // 초. 이 단위로 받고 저장한다.
const src = createSource(fetch);
const queue = [];
let running = null;
let idleTimer = null;
const cancelled = new Set();

const status = (contentId, patch) => chrome.runtime.sendMessage({ target: 'bg', type: 'status', contentId, patch }).catch(() => {});

async function run(job) {
  const { contentId, asrModel } = job;
  let lec = await store.get('lectures', contentId);
  if (!lec) {
    const info = await loadContentInfo(src, contentId);
    // 제목은 서버(content.php) 값을 우선한다. 페이지에서 온 값은 표시용 보조 정보로만 쓴다(레드팀 R3).
    const extra = job.meta ?? {};
    lec = { ...info, title: info.title || String(extra.title || '').slice(0, 200), course: String(extra.course || '').slice(0, 100),
      professor: String(extra.professor || '').slice(0, 50), week: Number(extra.week) || null,
      module: String(extra.module || '').slice(0, 200), period: String(extra.period || '').slice(0, 60),
      progressSec: 0, state: 'running', createdAt: Date.now() };
  }
  if (lec.state === 'done') return status(contentId, { state: 'done', progress: 1, title: lec.title });

  // 이어서 할 때는 마지막으로 확정된 슬라이드 끝에서 다시 시작한다(그 뒤 데이터는 지움).
  const prevSlides = await store.byLecture('slides', contentId);
  const resumeAt = prevSlides.length ? prevSlides[prevSlides.length - 1].end : 0;
  await store.deleteFrom(contentId, resumeAt);
  lec = { ...lec, state: 'running', progressSec: resumeAt, error: null, asrModel };
  await store.put('lectures', lec);
  status(contentId, { state: 'running', progress: resumeAt / lec.duration, title: lec.title, step: '준비 중' });

  const mp4 = await openMp4(src, lec.mediaUrl);
  const end = mp4.duration;
  status(contentId, { step: '받아쓰기 모델 불러오는 중' });
  const asr = await loadAsr(asrModel, (p) => {
    if (p.status === 'progress' && p.total > 5e6) status(contentId, { step: `모델 받는 중 ${Math.round(p.progress)}%` });
  });
  const det = createSlideDetector();
  try {
  for (let t = resumeAt; t < end; t += WINDOW) {
    if (cancelled.has(contentId)) { cancelled.delete(contentId); throw Object.assign(new Error('사용자가 중지함'), { paused: true }); }
    const t1 = Math.min(end, t + WINDOW);
    const w = await fetchWindow(src, mp4, t, t1, { slideEvery: 2 });
    const pcm=await decodeAudio16k(mp4,w.audio);
    const frames=await decodeKeyframes(mp4,w.keyframes);
    const finished = det.push(frames);
    if (t1 >= end) finished.push(...det.finish(end));
    try {
    const segs=await transcribe(asr,pcm,t);
    if (cancelled.has(contentId)) { cancelled.delete(contentId); throw Object.assign(new Error('사용자가 중지함'), { paused: true }); }
    await store.putMany('segments', segs.map((s) => ({ contentId, ...s })));
    const slideRows = [];
    for (const s of finished) {
      slideRows.push({ contentId, start: s.start, end: s.end, blob: await toJpeg(s.bitmap, { maxWidth: 1280 }) });
    }
    await store.putMany('slides', slideRows);
    lec.progressSec = t1;
    await store.put('lectures', lec);
    status(contentId, { state: 'running', progress: t1 / end, step: `받아쓰는 중 ${Math.round((t1 / end) * 100)}%` });
    } finally { for(const slide of finished)slide.bitmap.close(); }
  }
  lec.state = 'done';
  await store.put('lectures', lec);
  status(contentId, { state: 'done', progress: 1, step: '완료' });
  } finally { det.dispose(); }
}

async function pump() {
  if (running || !queue.length) return;
  clearTimeout(idleTimer);
  running = queue.shift();
  try {
    await run(running);
  } catch (e) {
    const paused = !!e.paused;
    const lec = await store.get('lectures', running.contentId);
    if (lec) await store.put('lectures', { ...lec, state: paused ? 'paused' : 'error', error: paused ? null : String(e.message || e) });
    status(running.contentId, { state: paused ? 'paused' : 'error', step: paused ? '일시정지' : `오류: ${e.message || e}` });
  } finally {
    running = null;
    if(queue.length) pump();
    else idleTimer = setTimeout(() => { if(!running && !queue.length) releaseAsr().catch(()=>{}); }, 30_000);
  }
}

async function loadGroups(contentId) {
  const [lecture, slides, segments] = await Promise.all([
    store.get('lectures', contentId), store.byLecture('slides', contentId), store.byLecture('segments', contentId),
  ]);
  if (!lecture || lecture.state !== 'done') throw new Error('아직 받아쓰기가 끝나지 않았습니다.');
  return { lecture, slides, segments };
}

const handlers = {
  async ping() { return { gpu: !!navigator.gpu }; },
  async lecture({ contentId }) { return { item: await store.get('lectures', contentId) }; },
  async getSummary({ contentId }) { return { item: await store.get('summaries', contentId) }; },
  async saveSummary({ contentId, item }) { await store.put('summaries', { ...item, contentId }); return {}; },
  // meta: { title, course, professor, week, module, period } — KLAS 목록에서 읽은 표시용 정보(선택)
  async enqueue({ contentId, meta, asrModel }) {
    if (running?.contentId === contentId || queue.some((j) => j.contentId === contentId)) return { queued: true };
    cancelled.delete(contentId);
    queue.push({ contentId, meta, asrModel: asrModel === 'base' ? 'base' : 'small' });
    status(contentId, { state: 'queued', step: '대기 중' });
    pump();
    return { queued: true };
  },
  async cancel({ contentId }) {
    const i = queue.findIndex((j) => j.contentId === contentId);
    if (i >= 0) { queue.splice(i, 1); status(contentId, { state: 'paused', step: '일시정지' }); }
    else if (running?.contentId === contentId) cancelled.add(contentId);
    return { ok: true };
  },
  async pack({ contentId, preset, provider }) {
    const { lecture, slides, segments } = await loadGroups(contentId);
    const pack = await buildPack({ lecture, slides, segments, preset, provider, toJpeg });
    return { ...pack, title: lecture.title };
  },
  async report({ contentId, summary, meta }) {
    const { lecture, slides, segments } = await loadGroups(contentId);
    const groups = groupBySlide(slides, segments);
    const html = await buildReport({ lecture, groups, summary, meta: { ...meta, asrModel: lecture.asrModel || 'whisper-small' } });
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    return { url, title: lecture.title };
  },
  async list() {
    return { items: await store.allLectures() };
  },
  async remove({ contentId }) {
    if (running?.contentId === contentId || queue.some(j => j.contentId === contentId)) throw new Error('받아쓰기가 멈춘 뒤 삭제할 수 있습니다. 잠시 후 다시 시도하세요.');
    await store.deleteLecture(contentId);
    return { ok: true };
  },
};

// 확장 내부(background)에서 온 메시지만 받는다. 콘텐츠 스크립트(탭에서 온 메시지)는 거부한다(레드팀 R3).
const SELF = chrome.runtime.getURL('');
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target !== 'offscreen') return;
  if (sender.id !== chrome.runtime.id || sender.tab || !String(sender.url || '').startsWith(SELF)) return;
  if (!Object.hasOwn(handlers, msg.cmd)) return;
  if (msg.contentId !== undefined && !/^[0-9a-f]{8,32}$/i.test(String(msg.contentId))) { reply({ ok: false, error: 'bad contentId' }); return; }
  const h = handlers[msg.cmd];
  h(msg).then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, error: String(e.message || e) }));
  return true;
});
