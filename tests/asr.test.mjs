import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Browser pipeline calls are controlled here so disposal races are deterministic.
const file = new URL('../extension/src/core/asr.js', import.meta.url);
const source = readFileSync(file, 'utf8')
  .replace(/import \{ pipeline, env \} from [^;]+;/, '')
  .replaceAll('import.meta.url', JSON.stringify(file.href))
  .replace(/export /g, '');
function fixture({ run, dispose, create } = {}) {
  const events = [], options = [];
  const context = vm.createContext({
    URL, console, env: { backends: { onnx: { wasm: {} } } },
    navigator: { gpu: { requestAdapter: async () => ({}) } },
    pipeline: async (_, id, opts) => {
      options.push(opts);
      await create?.();
      const asr = async (...args) => {
        events.push('start');
        const result = await run?.(...args);
        events.push('end');
        return result || { text: '테스트', chunks: [{ text: '테스트', timestamp: [0, 1] }] };
      };
      asr.dispose = async () => { events.push('dispose'); await dispose?.(); };
      return asr;
    },
  });
  vm.runInContext(source + '\nglobalThis.api = { loadAsr, transcribe, releaseAsr };', context);
  return { ...context.api, events, options };
}
const pcm = () => new Float32Array(16000);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('ASR release waits for every chunk in an active transcription', async () => {
  const gate = deferred();
  const f = fixture({ run: () => gate.promise });
  const model = await f.loadAsr('base');
  const result = f.transcribe(model, new Float32Array(16000 * 40));
  await tick();
  const released = f.releaseAsr();
  await tick();
  const duringRun = [...f.events];
  gate.resolve();
  await Promise.all([result, released]);
  assert.deepEqual(duringRun, ['start']);
  assert.deepEqual(f.events, ['start', 'end', 'start', 'end', 'dispose']);
});

test('ASR concurrent loads share one pipeline and serialize inference', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.loadAsr('base'), f.loadAsr('base')]);
  assert.equal(a, b);
  assert.equal(f.options.length, 1);
  await Promise.all([f.transcribe(a, pcm()), f.transcribe(b, pcm())]);
  assert.deepEqual(f.events, ['start', 'end', 'start', 'end']);
});

test('ASR release requested during loading disposes the eventual model', async () => {
  const gate = deferred();
  const f = fixture({ create: () => gate.promise });
  const loading = f.loadAsr('base');
  await tick();
  const released = f.releaseAsr();
  gate.resolve();
  await Promise.all([loading, released]);
  assert.deepEqual(f.events, ['dispose']);
});

test('ASR failed disposal does not poison future model loads', async () => {
  let first = true;
  const f = fixture({ dispose: () => { if (first) { first = false; throw Error('dispose failed'); } } });
  await f.loadAsr('base');
  await assert.rejects(f.releaseAsr(), /dispose failed/);
  const model = await f.loadAsr('base');
  await f.transcribe(model, pcm());
  await f.releaseAsr();
  assert.equal(f.options.length, 2);
});

test('ASR rejects stale handles before calling a disposed pipeline', async () => {
  const f = fixture();
  const model = await f.loadAsr('base');
  await f.releaseAsr();
  await assert.rejects(f.transcribe(model, pcm()), /해제/);
  assert.deepEqual(f.events, ['dispose']);
});

test('ASR model changes wait for inference and decoder dtype is part of the cache key', async () => {
  const gate = deferred();
  const f = fixture({ run: () => gate.promise });
  const original = await f.loadAsr('small', undefined, 'q4');
  const result = f.transcribe(original, pcm());
  await tick();
  const changed = f.loadAsr('small', undefined, 'q8');
  await tick();
  const duringRun = [...f.events];
  gate.resolve();
  await result;
  const next = await changed;
  assert.deepEqual(duringRun, ['start']);
  assert.notEqual(next, original);
  assert.equal(f.options[1].dtype.decoder_model_merged, 'q8');
});
