// 백그라운드 처리 엔진(offscreen 문서). 한 번에 한 강의씩 받아쓰기·슬라이드 캡처를 하고 IndexedDB에 저장한다.
// offscreen 문서에서는 chrome.runtime만 쓸 수 있어 상태는 background로 메시지를 보내 기록한다.
import { createSource, loadContentInfo, openMp4, fetchWindow, decodeAudio16k, decodeKeyframes } from './src/core/media.js';
import { createSlideDetector, toJpeg } from './src/core/slides.js';
import { buildPack, groupBySlide } from './src/core/pack.js';
import { buildReport } from './src/core/report.js';
import * as store from './src/core/store.js';

const WINDOW = 120; // 초. 이 단위로 받고 저장한다.
const queue = [];
let running = null;
let activeAbort = null;
const cancelled = new Set();

// ---- 받아쓰기 작업자 풀 ----
// 모델을 중복으로 올리지 않는다. GPU/CPU 모두 한 작업자만 사용한다.
const MAX_WORKERS = 1;
let workers = [];
let workersModel = null;
let gpuOk = true;
let playerUntil = 0; // 강의 플레이어가 열려 있다는 신호를 받은 뒤 이 시각까지는 1개만 쓴다
function parallelNow() { return gpuOk && Date.now() > playerUntil ? MAX_WORKERS : 1; }
function createWorker() {
  const w = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
  let seq = 0;
  const pend = new Map();
  w.onmessage = ({ data }) => {
    if (data?.diagnostic) { console.warn('asr worker diagnostic', data.diagnostic); return; }
    const p = pend.get(data?.id);
    if (!p) return;
    if (data.ok === undefined && data.progress !== undefined) { p.onProgress?.(data.progress); return; }
    pend.delete(data.id);
    if (data.ok) p.res(data);
    else {
      const error = new Error(data.error || '받아쓰기 작업자 오류');
      if (data.code) error.code = data.code;
      if (data.stack) error.stack = data.stack;
      p.rej(error);
    }
  };
  const item = { busy: 0, device: null, dead: false };
  item.terminate = (error = new Error('작업자 종료')) => {
    if (item.dead) return;
    item.dead = true;
    w.terminate();
    for (const p of pend.values()) p.rej(error);
    pend.clear();
  };
  w.onerror = (e) => item.terminate(new Error(e.message || '받아쓰기 작업자 오류'));
  w.onmessageerror = () => item.terminate(new Error('받아쓰기 작업자 응답을 읽을 수 없습니다.'));
  item.call = (msg, transfer = [], onProgress) => new Promise((res, rej) => {
    if (item.dead) { rej(new Error('작업자 종료')); return; }
    const id = ++seq;
    pend.set(id, { res, rej, onProgress });
    try { w.postMessage({ ...msg, id }, transfer); }
    catch (e) { pend.delete(id); rej(e); }
  });
  return item;
}
function terminateWorkers() { for (const w of workers) w.terminate(); workers = []; workersModel = null; }
// 사용하지 않는 작업자는 종료한다.
function trimWorkers(n) {
  for (let i = workers.length - 1; i >= n; i--) {
    if (!workers[i].busy) { workers[i].terminate(); workers.splice(i, 1); }
  }
}
// 다음 대기 강의에서도 같은 모델을 재사용하고, 모델 설정이 달라지면 이전 작업자를 해제한다.
async function ensureWorkers(n, asrModel, onProgress) {
  if (workersModel !== asrModel) terminateWorkers();
  workersModel = asrModel;
  workers = workers.filter((w) => !w.dead);
  n = gpuOk ? Math.min(MAX_WORKERS, Math.max(1, n)) : 1;
  trimWorkers(n);
  while (workers.length < n) {
    const w = createWorker();
    workers.push(w); // 로드 중에도 취소가 작업자를 찾아 종료할 수 있게 먼저 등록한다.
    let r;
    try { r = await w.call({ cmd: 'load', asrModel }, [], onProgress); }
    catch (e) { w.terminate(); workers = workers.filter((item) => item !== w); throw e; }
    w.device = r.device;
    if (r.device !== 'webgpu') gpuOk = false; // CPU(WASM)면 병렬 이득이 작아 1개만 쓴다
    if (!gpuOk) break;
  }
  return workers;
}
function pickWorker(n) {
  const pool = workers.slice(0, Math.max(1, Math.min(n, workers.length)));
  return pool.reduce((a, b) => (b.busy < a.busy ? b : a));
}

const status = (contentId, patch) => chrome.runtime.sendMessage({ target: 'bg', type: 'status', contentId, patch }).catch(() => {});

async function run(job) {
  const { contentId, asrModel } = job;
  const controller = new AbortController();
  const signal = controller.signal;
  activeAbort = controller;
  const src = createSource((url, init) => fetch(url, { ...init, signal }));
  let prefetched = null;
  const checkCancel = () => { if (cancelled.has(contentId)) { cancelled.delete(contentId); throw Object.assign(new Error('사용자가 중지함'), { paused: true }); } };
  try {
  checkCancel();
  let lec = await store.get('lectures', contentId);
  if (!lec) {
    const info = await loadContentInfo(src, contentId);
    checkCancel();
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
  checkCancel();
  const end = mp4.duration;
  status(contentId, { step: '받아쓰기 모델 불러오는 중' });
  let lastPct = -1, lastPctAt = 0; // 저장소 쓰기 폭주 방지(독립 검토 F5)
  const onModelProgress = (pct) => {
    const now = Date.now();
    if (pct !== lastPct && (pct === 100 || now - lastPctAt >= 1000)) {
      lastPct = pct; lastPctAt = now; status(contentId, { step: `모델 받는 중 ${pct}%` });
    }
  };
  await ensureWorkers(1, asrModel, onModelProgress);
  checkCancel();
  const det = createSlideDetector();
  let slideCount = prevSlides.length;
  const skippedVideo = [];
  const mmss = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  const inflight = [];
  let completed = false;
  // 받아쓰기가 끝난 가장 오래된 구간부터 저장한다(중간에 끊겨도 이어서 처리 가능하게 시간 순서 유지).
  const commit = async (job) => {
    try {
      const { segs } = await job.p;
      checkCancel();
      await store.putMany('segments', segs.map((s) => ({ contentId, ...s })));
      const slideRows = [];
      for (const s of job.finished) slideRows.push({ contentId, start: s.start, end: s.end, blob: await toJpeg(s.bitmap, { maxWidth: 1280 }) });
      await store.putMany('slides', slideRows);
      lec.progressSec = job.t1;
      await store.put('lectures', lec);
      checkCancel();
      slideCount += slideRows.length;
      // 패널의 실시간 확인용: 방금 받아쓴 마지막 두 문장과 지금까지의 슬라이드 수. 이 PC 안에서만 오간다.
      const preview = segs.slice(-2).map((s) => `${mmss(s.start)} ${s.text}`).join('\n').slice(0, 400);
      const n = parallelNow(), dev = workers[0]?.device === 'webgpu' ? 'GPU' : 'CPU';
      status(contentId, { state: 'running', progress: job.t1 / end, step: `받아쓰는 중 ${Math.round((job.t1 / end) * 100)}% · ${dev}${n > 1 ? ` · 동시 ${n}개` : ''}`, preview, slides: slideCount });
    } finally { for (const slide of job.finished) slide.bitmap.close(); }
  };
  const fetchPart = (t, t1, speculative = false) => retryOnce(
    () => fetchWindow(src, mp4, t, t1, { slideEvery: 2, signal, maxBytes: speculative ? 32 * 1024 * 1024 : Infinity }),
    `영상 받기(${mmss(t)}~${mmss(t1)})`, [3000, 10000, 30000], signal,
  );
  try {
  for (let t = resumeAt; t < end; t += WINDOW) {
    checkCancel();
    const t1 = Math.min(end, t + WINDOW);
    // 일시적 실패(네트워크·디코더 경합)는 구간 단위로 한 번 더 시도한다.
    // 슬라이드(비디오)만 계속 실패하면 그 구간 슬라이드만 건너뛰고 받아쓰기는 이어간다.
    let w;
    if (prefetched?.t === t) {
      const next = prefetched;
      prefetched = null;
      const result = await next.p;
      checkCancel();
      if (result.error?.code === 'PREFETCH_LIMIT') w = await fetchPart(t, t1);
      else if (result.error) throw result.error;
      else w = result.value;
    } else w = await fetchPart(t, t1);
    checkCancel();
    const pcm = await retryOnce(() => decodeAudio16k(mp4, w.audio, { signal }), `음성 디코딩(${mmss(t)}~${mmss(t1)})`, [1500], signal);
    checkCancel();
    let frames = [];
    try { frames = await retryOnce(() => decodeKeyframes(mp4, w.keyframes, { signal }), `화면 디코딩(${mmss(t)}~${mmss(t1)})`, [1500], signal); }
    catch (e) { if (signal.aborted || e?.paused) throw e; skippedVideo.push(`${mmss(t)}~${mmss(t1)}`); console.warn('slide decode skipped', e); }
    if (signal.aborted) { for (const frame of frames) frame.bitmap.close(); checkCancel(); }
    const finished = det.push(frames);
    if (t1 >= end) finished.push(...det.finish(end));
    const n = parallelNow();
    let queued = false;
    try {
    checkCancel();
    await ensureWorkers(n, asrModel);
    checkCancel();
    const worker = pickWorker(n);
    const copy = pcm.slice(); // 작업자로 넘기면 원본 버퍼가 비워지므로 복사본을 보낸다
    worker.busy++;
    const p = worker.call({ cmd: 'transcribe', pcm: copy.buffer, offset: t }, [copy.buffer]).finally(() => {
      worker.busy--;
      trimWorkers(parallelNow());
    });
    p.catch(() => {}); // 저장 단계(commit)에서 처리한다
    inflight.push({ t, t1, finished, p });
    queued = true;
    // ASR 한 개가 도는 동안 다음 구간의 압축 데이터만 받는다. 추가 PCM·슬라이드·모델은 만들지 않는다.
    if (t + WINDOW < end) {
      const nextT = t + WINDOW;
      prefetched = { t: nextT, p: fetchPart(nextT, Math.min(end, nextT + WINDOW), true).then(value => ({ value }), error => ({ error })) };
    }
    } finally { if (!queued) for (const slide of finished) slide.bitmap.close(); }
    // 동시에 돌릴 수 있는 개수를 넘으면 가장 오래된 구간이 끝나길 기다려 저장한다.
    while (inflight.length >= parallelNow()) await commit(inflight.shift());
  }
  while (inflight.length) await commit(inflight.shift());
  checkCancel();
  lec.state = 'done';
  await store.put('lectures', lec);
  checkCancel();
  status(contentId, { state: 'done', progress: 1, step: skippedVideo.length ? `완료 · 일부 구간 슬라이드 없음(${skippedVideo.slice(0, 3).join(', ')}${skippedVideo.length > 3 ? ' 외' : ''})` : '완료' });
  completed = true;
  } finally {
    if (!completed) terminateWorkers();
    await Promise.allSettled(inflight.map((job) => job.p));
    for (const job of inflight) for (const slide of job.finished) slide.bitmap.close();
    det.dispose();
  }
  } finally {
    controller.abort();
    if (prefetched) { await prefetched.p; prefetched = null; }
    if (activeAbort === controller) activeAbort = null;
  }
}

async function retryOnce(fn, what, waits = [1500], signal) {
  let last;
  for (let i = 0; i <= waits.length; i++) {
    if (signal?.aborted) throw Object.assign(new Error('사용자가 중지함'), { paused: true });
    try { return await fn(); }
    catch (e) {
      if (signal?.aborted || e?.paused || e?.name === 'AbortError' || e?.code === 'PREFETCH_LIMIT') throw e;
      last = e;
      if (i < waits.length) await new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, waits[i]);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(Object.assign(new Error('사용자가 중지함'), { paused: true })); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  throw Object.assign(new Error(`${what} 실패: ${last?.message || last}`), { cause: last });
}

// 학생이 읽고 바로 행동할 수 있는 문장으로 바꾼다. 원문은 끝에 짧게 붙여 문의할 때 쓰게 한다.
function friendlyError(e) {
  const raw = String(e?.message || e || '').slice(0, 160);
  let msg = '처리 중 문제가 생겼어요. "다시 시도"를 눌러 보세요.';
  if (/progressive mp4|지원하지 않는 콘텐츠/.test(raw)) msg = '이 강의는 지원하지 않는 영상 형식이에요(문서·외부 링크 강의 등).';
  else if (e?.code === 'ASR_REPETITION' || /받아쓰기 반복/.test(raw)) msg = '이 구간에서 받아쓰기가 같은 말을 반복했어요. 잘못된 반복 결과는 저장하지 않았습니다. 다시 시도해 주세요.';
  else if (e?.code === 'ASR_GENERATION_LIMIT') msg = '이 구간의 받아쓰기를 끝까지 읽지 못했어요. 불완전한 결과는 저장하지 않았습니다. 다시 시도해 주세요.';
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
  running = queue.shift();
  try {
    await run(running);
  } catch (e) {
    const paused = !!e.paused || cancelled.has(running.contentId);
    cancelled.delete(running.contentId);
    if (!paused) console.error('offscreen transcription failed', e);
    terminateWorkers(); // 일시정지·실패 뒤 메모리와 진행 중 작업을 남기지 않는다.
    const lec = await store.get('lectures', running.contentId);
    if (lec) await store.put('lectures', { ...lec, state: paused ? 'paused' : 'error', error: paused ? null : String(e.message || e) });
    status(running.contentId, paused ? { state: 'paused', step: '일시정지' } : { state: 'error', step: '오류 · 다시 시도할 수 있어요', error: friendlyError(e) });
  } finally {
    running = null;
    if(queue.length) pump();
    else terminateWorkers(); // 모든 대기 강의가 끝나면 모델을 즉시 해제한다. 노트 생성에는 모델이 필요 없다.
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
  async playerAlive() { playerUntil = Date.now() + 40_000; trimWorkers(1); return {}; },
  async jobs() { return { running: running?.contentId ?? null, queued: queue.map((j) => j.contentId) }; },
  async lecture({ contentId }) { return { item: await store.get('lectures', contentId) }; },
  async getSummary({ contentId }) { return { item: await store.get('summaries', contentId) }; },
  async saveSummary({ contentId, item }) { await store.put('summaries', { ...item, contentId }); return {}; },
  // meta: { title, course, professor, week, module, period } — KLAS 목록에서 읽은 표시용 정보(선택)
  async enqueue({ contentId, meta, asrModel }) {
    if (running?.contentId === contentId || queue.some((j) => j.contentId === contentId)) return { queued: true };
    cancelled.delete(contentId);
    queue.push({ contentId, meta, asrModel: asrModel === 'small' ? 'small' : 'base' });
    status(contentId, { state: 'queued', step: '대기 중' });
    pump();
    return { queued: true };
  },
  async cancel({ contentId }) {
    const i = queue.findIndex((j) => j.contentId === contentId);
    if (i >= 0) { queue.splice(i, 1); status(contentId, { state: 'paused', step: '일시정지' }); return { found: true }; }
    if (running?.contentId === contentId) {
      cancelled.add(contentId);
      activeAbort?.abort(); // 영상·메타데이터 요청과 재시도 대기도 함께 중지한다.
      terminateWorkers(); // 다음 2분 구간까지 기다리지 않고 모델 메모리를 반납한다.
      return { found: true };
    }
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
