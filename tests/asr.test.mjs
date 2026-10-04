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
function fixture({ run, dispose, create, gpu = true } = {}) {
  const events = [], options = [], calls = [];
  const context = vm.createContext({
    URL, console, env: { backends: { onnx: { wasm: {} } } },
    navigator: { gpu: { requestAdapter: async () => gpu ? ({}) : null } },
    pipeline: async (_, id, opts) => {
      options.push(opts);
      await create?.();
      const asr = async (...args) => {
        calls.push(args);
        events.push('start');
        const result = await run?.(...args);
        events.push('end');
        return result || { text: '테스트', chunks: [{ text: '테스트', timestamp: [0, 1] }] };
      };
      asr.model = { generation_config: { eos_token_id: 50257 } };
      asr.dispose = async () => { events.push('dispose'); await dispose?.(); };
      return asr;
    },
  });
  vm.runInContext(source + '\nglobalThis.api = { loadAsr, transcribe, releaseAsr };', context);
  return { ...context.api, events, options, calls };
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

test('ASR GPU defaults use base fp16 and small q4 while retaining explicit dtype overrides', async () => {
  const f = fixture();
  const base = await f.loadAsr();
  assert.equal(base.id, 'onnx-community/whisper-base');
  assert.equal(base.decoderDtype, 'fp16');
  assert.equal(f.options[0].device, 'webgpu');
  assert.equal(f.options[0].dtype.encoder_model, 'fp16');
  assert.equal(f.options[0].dtype.decoder_model_merged, 'fp16');
  assert.equal(await f.loadAsr('onnx-community/whisper-base'), base);
  assert.equal(f.options.length, 1);

  const small = await f.loadAsr('small');
  assert.equal(small.decoderDtype, 'q4');
  assert.equal(f.options[1].dtype.decoder_model_merged, 'q4');
  assert.deepEqual(f.events, ['dispose']);

  const override = await f.loadAsr('base', undefined, 'q4');
  assert.equal(override.decoderDtype, 'q4');
  assert.equal(f.options[2].dtype.decoder_model_merged, 'q4');
  assert.deepEqual(f.events, ['dispose', 'dispose']);
});

test('ASR CPU keeps q8 for both base and small after the GPU default precision change', async () => {
  const f = fixture({ gpu: false });
  const base = await f.loadAsr();
  assert.equal(base.device, 'wasm');
  assert.equal(f.options[0].dtype, 'q8');
  await f.loadAsr('small');
  assert.equal(f.options[1].device, 'wasm');
  assert.equal(f.options[1].dtype, 'q8');
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

// Match the reported 12:18 artifact: 2,290 characters, 222 consecutive greetings.
const repeatedGreeting = '여러분 안녕하세요 '.repeat(222) + '가'.repeat(70);
const repeatedOutput = () => ({ text: repeatedGreeting, chunks: [{ text: repeatedGreeting, timestamp: [0, 30] }] });

test('ASR retries the reported greeting loop on two shorter intervals with recovery-only ngram restriction', async () => {
  let count = 0;
  const f = fixture({ run: () => ++count === 1 ? repeatedOutput() : {
    text: count === 2 ? '여러분 안녕하세요. 오늘 수업을 시작하겠습니다.' : '이제 다음 내용을 설명하겠습니다.',
    chunks: [{ text: count === 2 ? '여러분 안녕하세요. 오늘 수업을 시작하겠습니다.' : '이제 다음 내용을 설명하겠습니다.', timestamp: [0, 30] }],
  } });
  const model = await f.loadAsr('small');
  const audio = new Float32Array(16000 * 20 + 1);
  const result = await f.transcribe(model, audio, 738);
  assert.equal(repeatedGreeting.length, 2290);
  assert.equal(f.options.length, 1);
  assert.deepEqual(f.calls.map(([part]) => part.length), [320001, 160000, 160001]);
  assert.equal(f.calls[1][0].byteOffset, audio.byteOffset);
  assert.equal(f.calls[2][0].byteOffset, audio.byteOffset + 160000 * 4);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, '여러분 안녕하세요. 오늘 수업을 시작하겠습니다.');
  assert.equal(result[0].start, 738);
  assert.equal(result[0].end, 748);
  assert.equal(result[1].start, 748);
  assert.equal(result[1].end, 738 + audio.length / 16000);
  for (const [, options] of f.calls) {
    assert.equal(options.return_timestamps, true);
    assert.equal(options.max_new_tokens, 440);
    assert.equal(options.language, 'korean');
  }
  assert.deepEqual(f.calls.map(([, options]) => options.no_repeat_ngram_size), [undefined, 6, 6]);
});

test('ASR rejects the whole transcription if repetition persists after a successful first retry half', async () => {
  let count = 0;
  const f = fixture({ run: () => ++count === 2 ? { text: '정상적인 첫 반쪽입니다.' } : repeatedOutput() });
  const model = await f.loadAsr('small');
  await assert.rejects(f.transcribe(model, new Float32Array(16000 * 29)), (error) => error.code === 'ASR_REPETITION');
  assert.equal(f.calls.length, 3);
  assert.equal(f.options.length, 1);
  // Failure does not poison the serialization queue or dispose the selected model.
  await f.releaseAsr();
  assert.equal(f.events.at(-1), 'dispose');
});

test('ASR detects a loop spread across timestamp chunks even without full result text', async () => {
  const f = fixture({ run: () => ({ chunks: Array.from({ length: 222 }, () => ({ text: '여러분 안녕하세요', timestamp: [0, 1] })) }) });
  const model = await f.loadAsr();
  await assert.rejects(f.transcribe(model, pcm()), (error) => error.code === 'ASR_REPETITION');
  assert.equal(f.calls.length, 2);
});

test('ASR preserves legitimate repeated words and short phrases without retry or deduplication', async () => {
  const text = '네, '.repeat(40) + '여러분 안녕하세요. '.repeat(12) + '반복해서 설명하겠습니다. 반복해서 설명하겠습니다.';
  const f = fixture({ run: () => ({ text }) });
  const model = await f.loadAsr();
  const result = await f.transcribe(model, new Float32Array(16000 * 29));
  assert.equal(f.calls.length, 1);
  assert.equal(result[0].text, text);
  assert.equal(f.calls[0][1].no_repeat_ngram_size, undefined);
});

test('ASR timestamps stay inside the source interval including missing, reversed and non-finite values', async () => {
  const f = fixture({ run: () => ({ chunks: [
    { text: '첫 문장', timestamp: [-2, 99] },
    { text: '둘째 문장', timestamp: [0.8, 0.2] },
    { text: '셋째 문장', timestamp: [NaN, Infinity] },
    { text: '넷째 문장', timestamp: [null, null] },
  ] }) });
  const model = await f.loadAsr();
  const result = await f.transcribe(model, pcm(), 738);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    { start: 738, end: 739, text: '첫 문장' },
    { start: 738.8, end: 738.8, text: '둘째 문장' },
    { start: 738, end: 739, text: '셋째 문장' },
    { start: 738, end: 739, text: '넷째 문장' },
  ]);
});

function observeGeneration(options, { complete = false } = {}) {
  // modeling_utils sends the initial decoder prompt once, then only new tokens.
  const prefix = [50258, 50264, 50359, 50363];
  options.streamer.put([prefix]);
  for (let step = 1; step <= options.max_new_tokens; step++) {
    options.streamer.put([[complete && step === options.max_new_tokens ? 50257n : 123n]]);
  }
  options.streamer.end();
}

test('ASR retries output that reached the token cap without EOS rather than accepting partial speech', async () => {
  let count = 0;
  const f = fixture({ run: (_, options) => {
    if (++count === 1) observeGeneration(options);
    return { text: `구간 ${count}` };
  } });
  const model = await f.loadAsr();
  const result = await f.transcribe(model, new Float32Array(16000 * 20));
  assert.equal(f.calls.length, 3);
  assert.deepEqual(result.map((chunk) => chunk.text).join(','), '구간 2,구간 3');
  assert.ok(f.calls.every(([, options]) => options.no_repeat_ngram_size === undefined));
});

test('ASR fails explicitly on persistent token exhaustion and accepts EOS exactly at the cap', async () => {
  let complete = false;
  const f = fixture({ run: (_, options) => {
    observeGeneration(options, { complete });
    return { text: '발화 내용을 그대로 보존합니다.' };
  } });
  const model = await f.loadAsr();
  await assert.rejects(f.transcribe(model, pcm()), (error) => error.code === 'ASR_GENERATION_LIMIT');
  assert.equal(f.calls.length, 2);
  complete = true;
  const result = await f.transcribe(model, pcm());
  assert.equal(f.calls.length, 3);
  assert.equal(result[0].text, '발화 내용을 그대로 보존합니다.');
});

test('ASR release waits through the bounded repetition retry', async () => {
  const gate = deferred();
  let count = 0;
  const f = fixture({ run: () => {
    if (++count === 1) return repeatedOutput();
    if (count === 2) return gate.promise;
    return { text: '마지막 구간입니다.' };
  } });
  const model = await f.loadAsr();
  const result = f.transcribe(model, new Float32Array(16000 * 20));
  await tick();
  const released = f.releaseAsr();
  await tick();
  assert.deepEqual(f.events, ['start', 'end', 'start']);
  gate.resolve({ text: '첫 재시도 구간입니다.' });
  await Promise.all([result, released]);
  assert.deepEqual(f.events, ['start', 'end', 'start', 'end', 'start', 'end', 'dispose']);
});
