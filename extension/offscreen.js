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
  // 슬라이드가 있으면 마지막 슬라이드 끝에서, 없으면(음성만·화면 디코딩 실패) 저장된 진행 지점에서 이어간다(독립 검토 F10).
  const savedLec = await store.get('lectures', contentId);
  const resumeAt = prevSlides.length ? prevSlides[prevSlides.length - 1].end : (savedLec?.progressSec || 0);
  await store.deleteFrom(contentId, resumeAt);
  lec = { ...lec, state: 'running', progressSec: resumeAt, error: null, asrModel };
  await store.put('lectures', lec);
  status(contentId, { state: 'running', progress: resumeAt / lec.duration, title: lec.title, step: '준비 중' });

  const mp4 = await openMp4(src, lec.mediaUrl);
  const end = mp4.duration;
  status(contentId, { step: '받아쓰기 모델 불러오는 중' });
  let lastPct = -1, lastPctAt = 0; // 저장소 쓰기 폭주 방지(독립 검토 F5)
  let asr = await loadAsr(asrModel, (p) => {
    if (p.status === 'progress' && p.total > 5e6) {
      const pct = Math.round(p.progress), now = Date.now();
      if (pct !== lastPct && now - lastPctAt >= 1000) { lastPct = pct; lastPctAt = now; status(contentId, { step: `모델 받는 중 ${pct}%` }); }
    }
  });
  const det = createSlideDetector();
  let slideCount = prevSlides.length;
  const skippedVideo = [];
  const mmss = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  try {
  for (let t = resumeAt; t < end; t += WINDOW) {
    if (cancelled.has(contentId)) { cancelled.delete(contentId); throw Object.assign(new Error('사용자가 중지함'), { paused: true }); }
    const t1 = Math.min(end, t + WINDOW);
    // 일시적 실패(네트워크·디코더 경합)는 구간 단위로 한 번 더 시도한다.
    // 슬라이드(비디오)만 계속 실패하면 그 구간 슬라이드만 건너뛰고 받아쓰기는 이어간다.
    const w = await retryOnce(() => fetchWindow(src, mp4, t, t1, { slideEvery: 2 }), `영상 받기(${mmss(t)}~${mmss(t1)})`, [3000, 10000, 30000]);
    const pcm = await retryOnce(() => decodeAudio16k(mp4, w.audio), `음성 디코딩(${mmss(t)}~${mmss(t1)})`);
    let frames = [];
    try { frames = await retryOnce(() => decodeKeyframes(mp4, w.keyframes), `화면 디코딩(${mmss(t)}~${mmss(t1)})`); }
    catch (e) { skippedVideo.push(`${mmss(t)}~${mmss(t1)}`); console.warn('slide decode skipped', e); }
    const finished = det.push(frames);
    if (t1 >= end) finished.push(...det.finish(end));
    try {
    // GPU 장치 리셋 등으로 받아쓰기 모델이 망가지면(예: 해제된 GPU 버퍼 재해제 'destroy' 오류) 모델을 새로 불러 그 구간을 한 번 더 한다.
    let segs;
    try { segs = await transcribe(asr, pcm, t); }
    catch (e) {
      if (e?.paused) throw e;
      console.warn('asr retry after failure', e);
      await releaseAsr().catch(() => {});
      asr = await loadAsr(asrModel);
      segs = await transcribe(asr, pcm, t);
    }
    if (cancelled.has(contentId)) { cancelled.delete(contentId); throw Object.assign(new Error('사용자가 중지함'), { paused: true }); }
    await store.putMany('segments', segs.map((s) => ({ contentId, ...s })));
    const slideRows = [];
    for (const s of finished) {
      slideRows.push({ contentId, start: s.start, end: s.end, blob: await toJpeg(s.bitmap, { maxWidth: 1280 }) });
    }
    await store.putMany('slides', slideRows);
    lec.progressSec = t1;
    await store.put('lectures', lec);
    slideCount += slideRows.length;
    // 패널의 실시간 확인용: 방금 받아쓴 마지막 두 문장과 지금까지의 슬라이드 수. 이 PC 안에서만 오간다.
    const preview = segs.slice(-2).map((s) => `${mmss(s.start)} ${s.text}`).join('\n').slice(0, 400);
    status(contentId, { state: 'running', progress: t1 / end, step: `받아쓰는 중 ${Math.round((t1 / end) * 100)}% · ${asr.device === 'webgpu' ? 'GPU' : 'CPU'}`, preview, slides: slideCount });
    } finally { for(const slide of finished)slide.bitmap.close(); }
  }
  lec.state = 'done';
  await store.put('lectures', lec);
  status(contentId, { state: 'done', progress: 1, step: skippedVideo.length ? `완료 · 일부 구간 슬라이드 없음(${skippedVideo.slice(0, 3).join(', ')}${skippedVideo.length > 3 ? ' 외' : ''})` : '완료' });
  } finally { det.dispose(); }
}

async function retryOnce(fn, what, waits = [1500]) {
  let last;
  for (let i = 0; i <= waits.length; i++) {
    try { return await fn(); }
    catch (e) { if (e?.paused) throw e; last = e; if (i < waits.length) await new Promise((r) => setTimeout(r, waits[i])); }
  }
  throw Object.assign(new Error(`${what} 실패: ${last?.message || last}`), { cause: last });
}

// 학생이 읽고 바로 행동할 수 있는 문장으로 바꾼다. 원문은 끝에 짧게 붙여 문의할 때 쓰게 한다.
function friendlyError(e) {
  const raw = String(e?.message || e || '').slice(0, 160);
  let msg = '처리 중 문제가 생겼어요. "다시 시도"를 눌러 보세요.';
  if (/progressive mp4|지원하지 않는 콘텐츠/.test(raw)) msg = '이 강의는 지원하지 않는 영상 형식이에요(문서·외부 링크 강의 등).';
  else if (/moov|faststart/.test(raw)) msg = '이 강의 영상은 구조상 부분 처리가 어려워요.';
  else if (/HTTP 40[134]/.test(raw)) msg = '강의 영상에 접근할 수 없어요. KLAS에서 강의를 다시 열어 본 뒤 다시 시도하세요.';
  else if (/HTTP|fetch|network|Failed to fetch|영상 받기/i.test(raw)) msg = '강의 영상을 받지 못했어요. 인터넷 연결을 확인하고 다시 시도하세요.';
  else if (/디코딩|Decoding|EncodingError|decode/i.test(raw)) msg = '영상 해석에 실패했어요. 강의를 재생 중이면 잠시 후 다시 시도하세요.';
  else if (/bad_alloc|memory|OOM|Out of memory/i.test(raw)) msg = '메모리가 부족해요. 다른 탭을 닫거나 설정에서 받아쓰기 모델을 base로 바꾼 뒤 다시 시도하세요.';
  else if (/webgpu|GPU|device lost|reading 'destroy'|onuncapturederror|mapAsync/i.test(raw)) msg = 'GPU 처리 중 문제가 생겼어요. Chrome을 다시 열고 다시 시도하세요.';
  else if (/model|onnx|huggingface|모델/i.test(raw)) msg = '받아쓰기 모델을 받지 못했어요. 인터넷 연결을 확인하고 다시 시도하세요.';
  return `${msg} (${raw})`.slice(0, 300);
}

async function pump() {
  if (running || !queue.length) return;
  clearTimeout(idleTimer);
  running = queue.shift();
  try {
    await run(running);
  } catch (e) {
    const paused = !!e.paused;
    if (!paused) await releaseAsr().catch(() => {}); // GPU 손실·메모리 부족 뒤 같은 모델 재사용 방지(독립 검토 F7)
    const lec = await store.get('lectures', running.contentId);
    if (lec) await store.put('lectures', { ...lec, state: paused ? 'paused' : 'error', error: paused ? null : String(e.message || e) });
    status(running.contentId, paused ? { state: 'paused', step: '일시정지' } : { state: 'error', step: '오류 · 다시 시도할 수 있어요', error: friendlyError(e) });
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
  // navigator.gpu가 있어도 이 문서에서 어댑터를 못 받으면 받아쓰기가 CPU(WASM)로 떨어져 3배 이상 느려진다(실측 추정).
  async ping() { const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null; return { gpu: !!adapter }; },
  async jobs() { return { running: running?.contentId ?? null, queued: queue.map((j) => j.contentId) }; },
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
    if (i >= 0) { queue.splice(i, 1); status(contentId, { state: 'paused', step: '일시정지' }); return { found: true }; }
    if (running?.contentId === contentId) { cancelled.add(contentId); return { found: true }; }
    return { found: false };
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
