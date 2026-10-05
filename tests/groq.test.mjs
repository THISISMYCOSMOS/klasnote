import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GROQ_MODEL, GroqError, MAX_GROQ_AUDIO_BYTES, MAX_GROQ_RESPONSE_BYTES,
  transcribeGroq, testGroqConnection, createGroqConfigStore,
} from '../native-host/groq.mjs';

// A structural M4A fixture for mock requests; no real provider or real credential.
const fixture = Buffer.from([0,0,0,24,102,116,121,112,77,52,65,32,0,0,0,0,77,52,65,32,105,115,111,109]);
const fixtureKey = 'gsk_mock_unit_test_only';
const args = { audioB64: fixture.toString('base64'), duration: 60, offset: 120, apiKey: fixtureKey };
const payload = { text: '강의 내용', segments: [{ start: 1.2, end: 3.4, text: ' 강의 내용 ' }] };
function response(data = payload, init = {}) { return new Response(JSON.stringify(data), { status: 200, ...init }); }
function run(data = payload, overrides = {}) { return transcribeGroq({ ...args, fetchImpl: async () => response(data), ...overrides }); }
const codeIs = (code) => (error) => error instanceof GroqError && error.code === code;
const temporaryPrefix = fileURLToPath(new URL('./.groq-test-', import.meta.url));

test('Groq request has fixed endpoint/model, Korean segment timestamps, M4A body and offset', async () => {
  let calls = 0;
  const output = await transcribeGroq({ ...args, fetchImpl: async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.deepEqual(request.headers, { Authorization: `Bearer ${fixtureKey}` });
    assert.ok(request.signal instanceof AbortSignal);
    assert.deepEqual([...request.body.keys()], ['file','model','language','response_format','timestamp_granularities[]','temperature']);
    assert.equal(request.body.get('model'), GROQ_MODEL);
    assert.equal(GROQ_MODEL, 'whisper-large-v3-turbo');
    assert.equal(request.body.get('language'), 'ko');
    assert.equal(request.body.get('response_format'), 'verbose_json');
    assert.deepEqual(request.body.getAll('timestamp_granularities[]'), ['segment']);
    assert.equal(request.body.get('temperature'), '0');
    const audio = request.body.get('file');
    assert.equal(audio.type, 'audio/mp4');
    assert.equal(audio.name, 'lecture.m4a');
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), fixture);
    return response();
  } });
  assert.equal(calls, 1);
  assert.deepEqual(output, { segments: [{ start: 121.2, end: 123.4, text: '강의 내용' }], model: GROQ_MODEL, provider: 'groq' });
  assert.ok(!JSON.stringify(output).includes(fixtureKey));
});

test('valid empty transcript and blank segments alone can be discarded', async () => {
  for (const data of [{ text: '' }, { text: ' ', segments: [] }, { segments: [] },
    { text: '', segments: [{ text: ' ' }] }]) {
    assert.deepEqual((await run(data)).segments, []);
  }
  const output = await run({ segments: [{ text: ' ' }, { start: 0, end: 60, text: 'full' }] });
  assert.deepEqual(output.segments, [{ start: 120, end: 180, text: 'full' }]);
});

test('nonempty transcript never gets fabricated timings when segments are absent/empty/malformed', async () => {
  for (const data of [null, [], {}, { text: 4 }, { text: '강의' }, { text: '강의', segments: null },
    { text: '강의', segments: [] }, { text: '강의', segments: [{ text: ' ' }] },
    { segments: [null] }, { segments: [{ start: 0, end: 1 }] },
    { segments: [{ start: 0, end: 1, text: 42 }] }]) {
    await assert.rejects(run(data), codeIs('GROQ_RESPONSE'));
  }
});

test('bad or materially out-of-range timestamps reject', async () => {
  for (const segment of [
    { start: -1, end: 1 }, { start: 0, end: 61 }, { start: 1, end: 1 },
    { start: 2, end: 1 }, { start: '0', end: 1 }, { start: 0, end: '1' },
    { start: null, end: 1 }, { start: 0, end: null }, { end: 1 },
  ]) await assert.rejects(run({ segments: [{ ...segment, text: 'bad' }] }), codeIs('GROQ_RESPONSE'));
  await assert.rejects(run({ segments: [{ start: 5, end: 10, text: 'first' }, { start: 4, end: 12, text: 'backwards' }] }), codeIs('GROQ_RESPONSE'));
  await assert.rejects(run({ segments: [{ start: 5, end: 10, text: 'first' }, { start: 6, end: 9, text: 'backwards end' }] }), codeIs('GROQ_RESPONSE'));
  await assert.rejects(run(payload, { offset: 1e17 }), codeIs('GROQ_RESPONSE'));
});

test('invalid input is rejected before provider invocation', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(); };
  const invalid = [
    { audioB64: '' }, { audioB64: '!!!!' }, { audioB64: 'Zg=' }, { audioB64: 'Zm9v====' },
    { audioB64: 'data:audio/mp4;base64,' + args.audioB64 }, { audioB64: 'AAAA====' },
    { audioB64: Buffer.from('not an mp4 header').toString('base64') },
    { audioB64: null }, { duration: 0 }, { duration: -1 }, { duration: 121.01 },
    { duration: NaN }, { duration: Infinity }, { duration: '60' },
    { offset: -1 }, { offset: Infinity }, { offset: '0' }, { offset: 1e308 }, { signal: {} },
  ];
  for (const overrides of invalid) await assert.rejects(transcribeGroq({ ...args, fetchImpl, ...overrides }), codeIs('GROQ_INPUT'));
  for (const apiKey of [null, '', 'short', 'gsk_secret\nInjected: header']) {
    await assert.rejects(transcribeGroq({ ...args, fetchImpl, apiKey }), codeIs('GROQ_AUTH'));
  }
  assert.equal(calls, 0);
});

test('large audio checks encoded and decoded bounds without automatic splitting', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(); };
  const bytes = Buffer.alloc(MAX_GROQ_AUDIO_BYTES);
  fixture.copy(bytes);
  await transcribeGroq({ ...args, audioB64: bytes.toString('base64'), fetchImpl });
  assert.equal(calls, 1);
  const oversized = Buffer.alloc(MAX_GROQ_AUDIO_BYTES + 1);
  fixture.copy(oversized);
  await assert.rejects(transcribeGroq({ ...args, audioB64: oversized.toString('base64'), fetchImpl }), codeIs('GROQ_INPUT_SIZE'));
  await assert.rejects(transcribeGroq({ ...args, audioB64: 'A'.repeat(4 * Math.ceil(MAX_GROQ_AUDIO_BYTES / 3) + 4), fetchImpl }), codeIs('GROQ_INPUT_SIZE'));
  assert.equal(calls, 1);
});

test('AAC edge tolerance allows 120.03 seconds without stretching returned timestamps', async () => {
  assert.deepEqual((await run({ segments: [{ start: 0, end: 120.03, text: 'edge' }] }, { duration: 120.03 })).segments,
    [{ start: 120, end: 240.03, text: 'edge' }]);
  await assert.rejects(run({ segments: [{ start: 0, end: 120.051, text: 'outside' }] }, { duration: 120.03 }), codeIs('GROQ_RESPONSE'));
});

test('captured Groq verbose_json timestamps clamp final rounded tick to actual AAC duration', async () => {
  const duration = 29.976961451247167;
  // Captured response shape/timestamps; lecture text, tokens and request ID anonymized.
  const captured = {
    task: 'transcribe', language: 'Korean', duration: 29.976999936,
    text: '테스트 구간 0 테스트 구간 1 테스트 구간 2 테스트 구간 3 테스트 구간 4 테스트 구간 5',
    segments: [[0,1.16],[2.9199998,6.3399997],[7.3999996,12.04],[13.4,15],[17.1,23.66],[23.66,29.98]]
      .map(([start,end],id) => ({ id, seek: 0, start, end, text: ` 테스트 구간 ${id}`, tokens: [50365,50423],
        temperature: 0, avg_logprob: -0.14811435, compression_ratio: 1.7283465, no_speech_prob: 0 })),
    x_groq: { id: 'req_mock_captured_shape' },
  };
  let calls = 0;
  const output = await run(captured, { duration, fetchImpl: async () => { calls++; return response(captured); } });
  assert.equal(calls, 1);
  assert.deepEqual(output.segments, captured.segments.map(segment => ({
    start: args.offset + segment.start, end: args.offset + Math.min(segment.end,duration), text: segment.text.trim(),
  })));
  assert.equal(output.segments.at(-1).end, args.offset + duration);
});

test('only end timestamps within one 20ms tick may be clamped; ordering and starts stay strict', async () => {
  const duration = 29.976961451247167;
  assert.deepEqual((await run({ segments: [{ start: 29, end: duration + 0.020, text: 'tick' }] }, { duration })).segments,
    [{ start: 149, end: 120 + duration, text: 'tick' }]);
  for (const segment of [
    { start: 29, end: duration + 0.020001 },
    { start: duration, end: duration + 0.01 },
    { start: duration + 0.001, end: duration + 0.01 },
    { start: -0.001, end: 1 },
  ]) await assert.rejects(run({ segments: [{ ...segment, text: 'bad' }] }, { duration }), codeIs('GROQ_RESPONSE'));
  // Clamping must not hide backwards provider ends, even when both end ticks exceed the boundary.
  await assert.rejects(run({ segments: [
    { start: 28, end: duration + 0.02, text: 'first' },
    { start: 29, end: duration + 0.01, text: 'backwards end' },
  ] }, { duration }), codeIs('GROQ_RESPONSE'));
});

test('429 preserves numeric Retry-After and issues only one network request', async () => {
  let calls = 0;
  const before = Date.now();
  await assert.rejects(transcribeGroq({ ...args, fetchImpl: async () => {
    calls++; return response({ error: fixtureKey }, { status: 429, headers: { 'retry-after': '12' } });
  } }), (error) => {
    assert.equal(error.code, 'GROQ_RATE_LIMIT');
    assert.equal(error.retryAfter, 12);
    assert.ok(error.retryAt >= before + 12_000 && error.retryAt <= Date.now() + 12_000);
    assert.ok(!JSON.stringify(error).includes(fixtureKey));
    return true;
  });
  assert.equal(calls, 1);
});

test('429 Retry-After HTTP dates are absolute, past dates become immediate, invalid dates remain absent', async () => {
  const future = Math.floor(Date.now() / 1000) * 1000 + 60_000;
  for (const [header, expected] of [[new Date(future).toUTCString(), future], [new Date(0).toUTCString(), 'past'], ['not-a-date', undefined], ['-10', undefined]]) {
    await assert.rejects(transcribeGroq({ ...args, fetchImpl: async () => response({}, { status: 429, headers: { 'retry-after': header } }) }), (error) => {
      assert.equal(error.code, 'GROQ_RATE_LIMIT');
      if (expected === 'past') { assert.equal(error.retryAfter, 0); assert.ok(error.retryAt <= Date.now()); }
      else assert.equal(error.retryAt, expected);
      return true;
    });
  }
});

test('HTTP and network errors are stable and never reflect credentials/provider body', async () => {
  for (const [status, code] of [[401,'GROQ_AUTH'],[403,'GROQ_AUTH'],[413,'GROQ_INPUT_SIZE'],[500,'GROQ_TRANSIENT'],[503,'GROQ_TRANSIENT'],[408,'GROQ_TRANSIENT'],[400,'GROQ_REQUEST'],[302,'GROQ_REQUEST']]) {
    let calls = 0, read = false;
    await assert.rejects(transcribeGroq({ ...args, fetchImpl: async () => {
      calls++; return { ok: false, status, headers: new Headers(), async text() { read = true; return fixtureKey; } };
    } }), (error) => {
      assert.equal(error.code, code); assert.ok(!String(error).includes(fixtureKey)); return true;
    });
    assert.equal(calls, 1); assert.equal(read, false);
  }
  await assert.rejects(transcribeGroq({ ...args, fetchImpl: async () => { throw new Error(`upstream leaked ${fixtureKey}`); } }), (error) => {
    assert.equal(error.code, 'GROQ_TRANSIENT'); assert.ok(!String(error.stack).includes(fixtureKey)); return true;
  });
});

test('response JSON has byte bounds, validates UTF8 and does not expose malformed body', async () => {
  await assert.rejects(transcribeGroq({ ...args, fetchImpl: async () => new Response(fixtureKey) }), (error) => {
    assert.equal(error.code, 'GROQ_RESPONSE'); assert.ok(!String(error).includes(fixtureKey)); return true;
  });
  await assert.rejects(transcribeGroq({ ...args, fetchImpl: async () => response({}, { headers: { 'content-length': MAX_GROQ_RESPONSE_BYTES + 1 } }) }), codeIs('GROQ_RESPONSE'));
  await assert.rejects(transcribeGroq({ ...args, fetchImpl: async () => new Response(' '.repeat(MAX_GROQ_RESPONSE_BYTES + 1)) }), codeIs('GROQ_RESPONSE'));
  await assert.rejects(transcribeGroq({ ...args, fetchImpl: async () => new Response(new Uint8Array([0xff])) }), codeIs('GROQ_RESPONSE'));
  await assert.rejects(transcribeGroq({ ...args, fetchImpl: async () => ({ ok: true, headers: new Headers(), text: async () => '한'.repeat(MAX_GROQ_RESPONSE_BYTES / 2) }) }), codeIs('GROQ_RESPONSE'));
});

test('pre-aborted and in-flight cancellation propagate as AbortError with no retry', async () => {
  const cancelled = new AbortController(); cancelled.abort(new Error(fixtureKey));
  let calls = 0;
  await assert.rejects(transcribeGroq({ ...args, signal: cancelled.signal, fetchImpl: async () => { calls++; return response(); } }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = transcribeGroq({ ...args, signal: controller.signal, fetchImpl: async (_, request) => {
    calls++;
    return new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      controller.abort(new Error(fixtureKey));
    });
  } });
  await assert.rejects(pending, (error) => { assert.equal(error.name, 'AbortError'); assert.ok(!String(error).includes(fixtureKey)); return true; });
  assert.equal(calls, 1);
});

test('timeout aborts the fetch and cleanup clears timers', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal, calls = 0;
  const pending = transcribeGroq({ ...args, fetchImpl: async (_, request) => {
    calls++; requestSignal = request.signal;
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  } });
  context.mock.timers.tick(120_000);
  await assert.rejects(pending, codeIs('GROQ_TRANSIENT'));
  assert.equal(requestSignal.aborted, true); assert.equal(calls, 1);
});

test('credential store status hides keys, atomic saving replaces only its file and removal restores env', async () => {
  const directory = await mkdtemp(temporaryPrefix);
  const file = join(directory, 'groq-config.json');
  try {
    const envKey = 'gsk_mock_environment_only';
    const store = createGroqConfigStore({ file, env: { GROQ_API_KEY: envKey } });
    assert.deepEqual(await store.status(), { configured: true, source: 'environment' });
    assert.equal(await store.get(), envKey);
    assert.deepEqual(await store.save(fixtureKey), { configured: true, source: 'file' });
    assert.deepEqual(await store.status(), { configured: true, source: 'file' });
    assert.equal(await store.get(), fixtureKey);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { apiKey: fixtureKey });
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    await store.save('gsk_mock_replacement_only');
    assert.equal(await store.get(), 'gsk_mock_replacement_only');
    assert.deepEqual(await readdir(directory), ['groq-config.json']);
    assert.deepEqual(await store.remove(), { configured: true, source: 'environment' });
    assert.equal(await store.get(), envKey);
    assert.deepEqual(await store.remove(), { configured: true, source: 'environment' });
    const empty = createGroqConfigStore({ file, env: {} });
    assert.equal(await empty.get(), null);
    assert.deepEqual(await empty.status(), { configured: false, source: null });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('credential store rejects malformed/oversized config without returning contents', async () => {
  const directory = await mkdtemp(temporaryPrefix);
  const file = join(directory, 'groq-config.json');
  try {
    const store = createGroqConfigStore({ file, env: {} });
    for (const body of [fixtureKey, JSON.stringify({ apiKey: fixtureKey + '\n' }), ' '.repeat(4097)]) {
      await writeFile(file, body);
      await assert.rejects(store.status(), (error) => { assert.equal(error.code, 'GROQ_CONFIG'); assert.ok(!String(error).includes(fixtureKey)); return true; });
    }
    await assert.rejects(store.save('bad\nkey'), codeIs('GROQ_AUTH'));
    await store.save(fixtureKey);
    assert.equal(await store.get(), fixtureKey);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('connection check only requests fixed model listing endpoint and checks ASR model availability', async () => {
  let calls = 0;
  assert.deepEqual(await testGroqConnection({ apiKey: fixtureKey, fetchImpl: async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.groq.com/openai/v1/models');
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    assert.deepEqual(request.headers, { Authorization: `Bearer ${fixtureKey}` });
    assert.equal(request.body, undefined);
    return response({ data: [{ id: GROQ_MODEL, active: true }, { id: 'other-model' }] });
  } }), { provider: 'groq', model: GROQ_MODEL, available: true });
  assert.equal(calls, 1);
  for (const data of [{ data: [] }, { data: [{ id: GROQ_MODEL, active: false }] }]) {
    await assert.rejects(testGroqConnection({ apiKey: fixtureKey, fetchImpl: async () => response(data) }), codeIs('GROQ_MODEL_UNAVAILABLE'));
  }
  for (const data of [{}, { data: [{}] }, { data: [null] }, { data: [{ id: 4 }] }]) {
    await assert.rejects(testGroqConnection({ apiKey: fixtureKey, fetchImpl: async () => response(data) }), codeIs('GROQ_RESPONSE'));
  }
});

test('connection check preserves safe 429/auth/transient errors, cancellation and response size', async () => {
  for (const [status, code] of [[429,'GROQ_RATE_LIMIT'],[401,'GROQ_AUTH'],[403,'GROQ_AUTH'],[500,'GROQ_TRANSIENT'],[400,'GROQ_REQUEST']]) {
    await assert.rejects(testGroqConnection({ apiKey: fixtureKey, fetchImpl: async () => response({ error: fixtureKey }, { status, headers: { 'retry-after': '10' } }) }), (error) => {
      assert.equal(error.code, code);
      if (status === 429) { assert.equal(error.retryAfter, 10); assert.ok(error.retryAt > Date.now()); }
      assert.ok(!String(error.stack).includes(fixtureKey)); return true;
    });
  }
  await assert.rejects(testGroqConnection({ apiKey: fixtureKey, fetchImpl: async () => { throw new Error(fixtureKey); } }), codeIs('GROQ_TRANSIENT'));
  await assert.rejects(testGroqConnection({ apiKey: fixtureKey, fetchImpl: async () => new Response(' '.repeat(MAX_GROQ_RESPONSE_BYTES + 1)) }), codeIs('GROQ_RESPONSE'));
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(testGroqConnection({ apiKey: fixtureKey, signal: controller.signal, fetchImpl: async () => { calls++; return response(); } }), { name: 'AbortError' });
  assert.equal(calls, 0);
});
