import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createModelProgress } from '../extension/src/core/model-progress.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  assert.fail('expected engine event was not emitted');
}
function source(relative) {
  const file = new URL(relative, import.meta.url);
  return readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(file.href));
}
const id = '0123456789abcdef';

function engine({ onLoad, onTranscribe, onFetch, onDecode, onPut, database = new Map() } = {}) {
  const instances = [], messages = [], statuses = [], fetches = [], writes = [], bitmaps = [], decodes = [];
  const rows = (name) => {
    if (!database.has(name)) database.set(name, new Map());
    return database.get(name);
  };
  const store = {
    get: async (name, key) => structuredClone(rows(name).get(key)),
    put: async (name, row) => { await onPut?.(name, row); return rows(name).set(row.contentId, structuredClone(row)); },
    putMany: async (name, values) => {
      for (const row of values) {
        rows(name).set(`${row.contentId}/${row.start}`, structuredClone(row));
        if (name === 'segments') writes.push(row.start);
      }
    },
    byLecture: async (name, contentId) => [...rows(name).values()].filter((r) => r.contentId === contentId).map((r) => structuredClone(r)).sort((a, b) => a.start - b.start),
    deleteFrom: async (contentId, from) => {
      for (const name of ['slides', 'segments']) for (const [key, row] of rows(name)) if (row.contentId === contentId && row.start >= from) rows(name).delete(key);
    },
  };
  class Worker {
    constructor() { this.dead = false; this.number = instances.length; instances.push(this); }
    terminate() { this.dead = true; }
    postMessage(msg) {
      messages.push({ worker: this.number, ...msg });
      let response;
      try {
        response = msg.cmd === 'load'
          ? (onLoad?.(msg, this) ?? { device: 'webgpu' })
          : (onTranscribe?.(msg, this) ?? { segs: [{ start: msg.offset, end: msg.offset + 1, text: 'test' }] });
      } catch (e) { response = Promise.reject(e); }
      Promise.resolve(response).then(
        (r) => { if (!this.dead) this.onmessage?.({ data: { id: msg.id, ok: true, ...r } }); },
        (e) => { if (!this.dead) this.onmessage?.({ data: { id: msg.id, ok: false, error: e.message, stack: e.stack } }); },
      );
    }
  }
  const context = vm.createContext({
    URL, Worker, Float32Array, Date, AbortController, fetch: async () => {}, console: { warn() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {}, store,
    chrome: { runtime: { id: 'test', getURL: (p) => 'chrome-extension://test/' + p, onMessage: { addListener() {} }, sendMessage: async (msg) => { statuses.push(msg.patch); return {}; } } },
    createSource: () => ({}), loadContentInfo: async (_, contentId) => ({ contentId, title: 'test', duration: 360, mediaUrl: 'test' }),
    openMp4: async () => ({ duration: 360 }),
    fetchWindow: async (_, __, t, t1, opts) => { fetches.push(t); await onFetch?.(t, t1, opts); return { audio: [t], keyframes: [{ ts: t, end: t1 }] }; },
    decodeAudio16k: async (_, audio, opts) => { decodes.push(audio[0]); await onDecode?.(audio, opts); return new Float32Array(16); },
    decodeKeyframes: async (_, frames) => frames.map((frame) => {
      const bitmap = { closed: 0, close() { this.closed++; } };
      bitmaps.push(bitmap);
      return { ...frame, bitmap };
    }),
    createSlideDetector: () => ({ push: (frames) => frames.map((f) => ({ ...f, start: f.ts })), finish: () => [], dispose() {} }),
    toJpeg: async () => null, buildPack() {}, groupBySlide() {}, buildReport() {},
  });
  vm.runInContext(source('../extension/offscreen.js') + '\nglobalThis.api = { ensureWorkers, terminateWorkers, run, handlers, getPool: () => workers };', context);
  return { ...context.api, instances, messages, statuses, fetches, writes, bitmaps, decodes, store, database };
}

test('ASR pool keeps exactly one model on GPU and CPU', async () => {
  const f = engine();
  await f.ensureWorkers(5, 'small');
  assert.equal(f.instances.length, 1);
  await f.handlers.playerAlive();
  assert.equal(f.getPool().length, 1);
  assert.equal(f.instances.length, 1);
  const cpu = engine({ onLoad: () => ({ device: 'wasm' }) });
  await cpu.ensureWorkers(2, 'small');
  await cpu.ensureWorkers(2, 'small');
  assert.equal(cpu.instances.length, 1);
  f.terminateWorkers(); cpu.terminateWorkers();
});

test('ASR pool terminates failed and still-loading workers without orphaning a model', async () => {
  const failed = engine({ onLoad: () => { throw Error('load failed'); } });
  await assert.rejects(failed.ensureWorkers(1, 'small'), /load failed/);
  assert.equal(failed.instances[0].dead, true);
  assert.equal(failed.getPool().length, 0);
  const gate = deferred();
  const loading = engine({ onLoad: () => gate.promise });
  const ready = loading.ensureWorkers(1, 'small');
  await tick();
  loading.terminateWorkers();
  await assert.rejects(ready, /작업자 종료/);
  gate.resolve({ device: 'webgpu' });
  assert.equal(loading.instances[0].dead, true);
  assert.equal(loading.getPool().length, 0);
});

test('ASR engine waits for the current window before dispatching the next one', async () => {
  const first = deferred();
  const f = engine({ onTranscribe: (msg) => msg.offset === 0 ? first.promise : undefined });
  const running = f.run({ contentId: id, asrModel: 'small' });
  await until(() => f.messages.some((m) => m.cmd === 'transcribe' && m.offset === 0));
  assert.deepEqual(f.messages.filter((m) => m.cmd === 'transcribe').map((m) => m.offset), [0]);
  assert.deepEqual(f.fetches, [0, 120], 'only one next encoded window is prefetched');
  assert.deepEqual(f.decodes, [0], 'next audio is not decoded while current inference runs');
  assert.deepEqual(f.writes, []);
  first.resolve({ segs: [{ start: 0, end: 1, text: 'first' }] });
  await running;
  assert.deepEqual(f.writes, [0, 120, 240]);
  assert.equal((await f.store.get('lectures', id)).state, 'done');
  assert.ok(f.bitmaps.every((b) => b.closed === 1));
  f.terminateWorkers();
});

test('ASR cancels a pending download and advances the queued lecture immediately', async () => {
  const nextId = 'fedcba9876543210';
  let first = true, aborted = false;
  const f = engine({ onFetch: (_, __, { signal }) => {
    if (!first) return;
    first = false;
    return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(Error('aborted'), { name: 'AbortError' })); }, { once: true }));
  } });
  await f.handlers.enqueue({ contentId: id, asrModel: 'base' });
  await until(() => f.fetches.length === 1);
  await f.handlers.enqueue({ contentId: nextId, asrModel: 'base' });
  await f.handlers.cancel({ contentId: id });
  await until(() => f.statuses.some((s) => s.state === 'done'));
  assert.equal(aborted, true);
  assert.equal((await f.store.get('lectures', id)).state, 'paused');
  assert.equal((await f.store.get('lectures', nextId)).state, 'done');
  assert.deepEqual(await f.store.byLecture('segments', id), []);
});

test('ASR aborts prefetched bytes on cancel without decoding or committing them', async () => {
  const gate = deferred();
  let aborted = false;
  const f = engine({ onTranscribe: () => gate.promise, onFetch: (t, _, { signal }) => {
    if (t !== 120) return;
    return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(Error('aborted'), { name: 'AbortError' })); }, { once: true }));
  } });
  await f.handlers.enqueue({ contentId: id, asrModel: 'base' });
  await until(() => f.fetches.includes(120));
  await f.handlers.cancel({ contentId: id });
  await until(() => f.statuses.some((s) => s.state === 'paused'));
  assert.equal(aborted, true);
  assert.deepEqual(f.decodes, [0]);
  assert.deepEqual(f.writes, []);
  assert.ok(f.instances.every((w) => w.dead));
  gate.resolve({ segs: [] });
});

test('ASR forwards decode cancellation and starts the next lecture without waiting for old PCM', async () => {
  const nextId = 'fedcba9876543210';
  let first = true, aborted = false;
  const f = engine({ onDecode: (_, { signal }) => {
    if (!first) return;
    first = false;
    return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(Error('aborted'), { name: 'AbortError' })); }, { once: true }));
  } });
  await f.handlers.enqueue({ contentId: id, asrModel: 'base' });
  await until(() => f.decodes.length === 1);
  await f.handlers.enqueue({ contentId: nextId, asrModel: 'base' });
  await f.handlers.cancel({ contentId: id });
  await until(() => f.statuses.some((s) => s.state === 'done'));
  assert.equal(aborted, true);
  assert.equal((await f.store.get('lectures', id)).state, 'paused');
  assert.equal((await f.store.get('lectures', nextId)).state, 'done');
  assert.deepEqual(await f.store.byLecture('segments', id), []);
});

test('ASR cancellation after the final checkpoint remains paused rather than reporting done', async () => {
  const gate = deferred();
  let reached = false;
  const f = engine({ onPut: (name, row) => {
    if (name === 'lectures' && row.progressSec === 360 && row.state === 'running') { reached = true; return gate.promise; }
  } });
  await f.handlers.enqueue({ contentId: id, asrModel: 'base' });
  await until(() => reached);
  await f.handlers.cancel({ contentId: id });
  gate.resolve();
  await until(() => f.statuses.some((s) => s.state === 'paused'));
  assert.equal((await f.store.get('lectures', id)).state, 'paused');
  assert.equal(f.statuses.some((s) => s.state === 'done'), false);
});

test('ASR retries wait behind the running lecture, deduplicate, and preserve FIFO priority', async () => {
  const nextId = 'fedcba9876543210', lastId = 'aaaabbbbccccdddd';
  const gate = deferred();
  const f = engine({ onTranscribe: (msg) => msg.offset === 0 ? gate.promise : undefined });
  await f.handlers.enqueue({ contentId: id, asrModel: 'base' });
  await until(() => f.messages.some((m) => m.cmd === 'transcribe'));
  await f.handlers.enqueue({ contentId: nextId, asrModel: 'base' });
  await f.handlers.enqueue({ contentId: lastId, asrModel: 'base' });
  await f.handlers.enqueue({ contentId: nextId, asrModel: 'base' });
  await f.handlers.enqueue({ contentId: id, asrModel: 'base' });
  assert.equal((await f.handlers.jobs()).running, id);
  assert.deepEqual(Array.from((await f.handlers.jobs()).queued), [nextId, lastId]);
  assert.equal(await f.store.get('lectures', nextId), undefined);
  assert.equal(f.instances.length, 1);
  gate.resolve({ segs: [{ start: 0, end: 1, text: 'first' }] });
  await until(() => f.statuses.filter((s) => s.state === 'done').length === 3);
  await tick();
  assert.equal((await f.handlers.jobs()).running, null);
  assert.deepEqual([...f.database.get('lectures').values()].map((l) => l.contentId), [id, nextId, lastId]);
  assert.ok([...f.database.get('lectures').values()].every((l) => l.state === 'done'));
  assert.equal(f.instances.length, 1, 'queued lectures share one model');
  assert.ok(f.instances.every((w) => w.dead), 'model is released as soon as the queue finishes');
});

async function pausedFixture() {
  let hold = true;
  const gate = deferred();
  const f = engine({ onTranscribe: (msg) => hold && msg.offset >= 120 ? gate.promise : undefined });
  await f.handlers.enqueue({ contentId: id, asrModel: 'small' });
  await until(() => f.statuses.some((s) => s.progress === 1 / 3));
  await f.handlers.cancel({ contentId: id });
  await until(() => f.statuses.some((s) => s.state === 'paused'));
  assert.ok(f.instances.every((w) => w.dead));
  assert.equal(f.getPool().length, 0);
  assert.equal((await f.store.get('lectures', id)).progressSec, 120);
  assert.deepEqual(f.writes, [0]);
  hold = false;
  gate.resolve({ segs: [{ start: 999, end: 1000, text: 'late reply' }] });
  await tick();
  assert.deepEqual(f.writes, [0]);
  return f;
}

test('ASR cancel releases workers immediately and retry resumes only committed windows', async () => {
  const f = await pausedFixture();
  const fetchedBefore = f.fetches.length;
  await f.handlers.enqueue({ contentId: id, asrModel: 'small' });
  await until(() => f.statuses.some((s) => s.state === 'done'));
  assert.deepEqual(f.fetches.slice(fetchedBefore), [120, 240]);
  assert.deepEqual(f.writes, [0, 120, 240]);
  assert.ok(f.bitmaps.every((b) => b.closed === 1));
  f.terminateWorkers();
});

test('ASR reload resumes from persisted checkpoint in a fresh engine', async () => {
  const previous = await pausedFixture();
  const fresh = engine({ database: previous.database });
  await fresh.run({ contentId: id, asrModel: 'small' });
  assert.deepEqual(fresh.fetches, [120, 240]);
  assert.deepEqual(fresh.writes, [120, 240]);
  assert.equal((await fresh.store.get('lectures', id)).state, 'done');
  fresh.terminateWorkers();
});

test('ASR cancel advances to the next queued lecture without waiting for abandoned inference', async () => {
  const nextId = 'fedcba9876543210';
  const abandoned = deferred();
  const f = engine({
    onLoad: () => ({ device: 'wasm' }),
    onTranscribe: (_, worker) => worker.number === 0 ? abandoned.promise : undefined,
  });
  await f.handlers.enqueue({ contentId: id, asrModel: 'small' });
  await until(() => f.messages.some((m) => m.cmd === 'transcribe'));
  await f.handlers.enqueue({ contentId: nextId, asrModel: 'small' });
  assert.deepEqual(Array.from((await f.handlers.jobs()).queued), [nextId]);
  await f.handlers.cancel({ contentId: id });
  await until(() => f.statuses.some((s) => s.state === 'done'));
  await tick();
  assert.equal(f.instances[0].dead, true);
  assert.equal((await f.store.get('lectures', id)).state, 'paused');
  assert.equal((await f.store.get('lectures', nextId)).state, 'done');
  assert.equal((await f.handlers.jobs()).running, null);
  assert.deepEqual(Array.from((await f.handlers.jobs()).queued), []);
  abandoned.resolve({ segs: [{ start: 999, end: 1000, text: 'abandoned reply' }] });
  await tick();
  assert.deepEqual(await f.store.byLecture('segments', id), []);
  assert.deepEqual((await f.store.byLecture('segments', nextId)).map((s) => s.start), [0, 120, 240]);
  assert.ok(f.bitmaps.every((b) => b.closed === 1));
  f.terminateWorkers();
});

test('ASR worker serializes retry and release and sends the original failure stack', async () => {
  const events = [], replies = [], gate = deferred();
  let first = true;
  const context = vm.createContext({
    Float32Array, createModelProgress, console: { warn() {}, error() {} },
    self: { postMessage: (msg) => replies.push(msg) },
    loadAsr: async () => { events.push('load'); return { device: 'webgpu' }; },
    releaseAsr: async () => { events.push('release'); },
    transcribe: async () => {
      events.push('transcribe');
      if (first) { first = false; const e = Error("Cannot read properties of undefined (reading 'destroy')"); e.stack = 'original ORT stack'; throw e; }
      await gate.promise;
      events.push('completed');
      return [];
    },
  });
  vm.runInContext(source('../extension/asr-worker.js'), context);
  context.self.onmessage({ data: { id: 1, cmd: 'load', asrModel: 'small' } });
  await until(() => replies.some((r) => r.id === 1 && r.ok));
  context.self.onmessage({ data: { id: 2, cmd: 'transcribe', pcm: new Float32Array(1).buffer, offset: 0 } });
  context.self.onmessage({ data: { id: 3, cmd: 'release' } });
  await until(() => events.filter((e) => e === 'transcribe').length === 2);
  assert.deepEqual(events, ['load', 'transcribe', 'release', 'load', 'transcribe']);
  assert.equal(replies.find((r) => r.diagnostic)?.diagnostic, 'original ORT stack');
  gate.resolve();
  await until(() => replies.some((r) => r.id === 3 && r.ok));
  assert.deepEqual(events.slice(-2), ['completed', 'release']);
});

test('ASR persistent quality errors keep their code without restarting the model recovery loop', async () => {
  for (const code of ['ASR_REPETITION', 'ASR_GENERATION_LIMIT']) {
    const events = [], replies = [];
    const context = vm.createContext({
      Float32Array, createModelProgress, console: { warn() {}, error() {} },
      self: { postMessage: (msg) => replies.push(msg) },
      loadAsr: async () => { events.push('load'); return { device: 'webgpu' }; },
      releaseAsr: async () => { events.push('release'); },
      transcribe: async () => { events.push('transcribe'); throw Object.assign(Error('persistent quality failure'), { code }); },
    });
    vm.runInContext(source('../extension/asr-worker.js'), context);
    context.self.onmessage({ data: { id: 1, cmd: 'load', asrModel: 'base' } });
    await until(() => replies.some((r) => r.id === 1 && r.ok));
    context.self.onmessage({ data: { id: 2, cmd: 'transcribe', pcm: new Float32Array(1).buffer, offset: 0 } });
    await until(() => replies.some((r) => r.id === 2));
    assert.deepEqual(events, ['load', 'transcribe']);
    const failed = replies.find((r) => r.id === 2);
    assert.equal(failed.ok, false);assert.equal(failed.code, code);
    assert.equal(replies.some((r) => r.diagnostic), false);
  }
});
