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

function engine({ onLoad, onTranscribe, database = new Map() } = {}) {
  const instances = [], messages = [], statuses = [], fetches = [], writes = [], bitmaps = [];
  const rows = (name) => {
    if (!database.has(name)) database.set(name, new Map());
    return database.get(name);
  };
  const store = {
    get: async (name, key) => structuredClone(rows(name).get(key)),
    put: async (name, row) => rows(name).set(row.contentId, structuredClone(row)),
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
    URL, Worker, Float32Array, Date, fetch: async () => {}, console: { warn() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {}, store,
    chrome: { runtime: { id: 'test', getURL: (p) => 'chrome-extension://test/' + p, onMessage: { addListener() {} }, sendMessage: async (msg) => { statuses.push(msg.patch); return {}; } } },
    createSource: () => ({}), loadContentInfo: async () => ({ contentId: id, title: 'test', duration: 360, mediaUrl: 'test' }),
    openMp4: async () => ({ duration: 360 }),
    fetchWindow: async (_, __, t, t1) => { fetches.push(t); return { audio: [], keyframes: [{ ts: t, end: t1 }] }; },
    decodeAudio16k: async () => new Float32Array(16),
    decodeKeyframes: async (_, frames) => frames.map((frame) => {
      const bitmap = { closed: 0, close() { this.closed++; } };
      bitmaps.push(bitmap);
      return { ...frame, bitmap };
    }),
    createSlideDetector: () => ({ push: (frames) => frames.map((f) => ({ ...f, start: f.ts })), finish: () => [], dispose() {} }),
    toJpeg: async () => null, buildPack() {}, groupBySlide() {}, buildReport() {},
  });
  vm.runInContext(source('../extension/offscreen.js') + '\nglobalThis.api = { ensureWorkers, terminateWorkers, run, handlers, getPool: () => workers };', context);
  return { ...context.api, instances, messages, statuses, fetches, writes, bitmaps, store, database };
}

test('ASR pool caps at two workers, keeps CPU at one, and retires idle second worker during playback', async () => {
  const f = engine();
  await f.ensureWorkers(5, 'small');
  assert.equal(f.instances.length, 2);
  await f.handlers.playerAlive();
  assert.equal(f.getPool().length, 1);
  assert.equal(f.instances[1].dead, true);
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

test('ASR engine commits in lecture order when later windows finish first', async () => {
  const first = deferred();
  const f = engine({ onTranscribe: (msg) => msg.offset === 0 ? first.promise : undefined });
  const running = f.run({ contentId: id, asrModel: 'small' });
  await until(() => f.messages.some((m) => m.cmd === 'transcribe' && m.offset === 120));
  assert.deepEqual(f.writes, []);
  first.resolve({ segs: [{ start: 0, end: 1, text: 'first' }] });
  await running;
  assert.deepEqual(f.writes, [0, 120, 240]);
  assert.equal((await f.store.get('lectures', id)).state, 'done');
  assert.ok(f.bitmaps.every((b) => b.closed === 1));
  f.terminateWorkers();
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
