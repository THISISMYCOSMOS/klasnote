import test from 'node:test';
import assert from 'node:assert/strict';
import { createSource, fetchWindow, decodeAudio16k, decodeKeyframes } from '../extension/src/core/media.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function withGlobals(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, values);
  try { await fn(); }
  finally { for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
}
const audioMp4 = { audio: { info: { codec: 'mp4a', audio: { sample_rate: 48000, channel_count: 1 } } } };
const audioSamples = [{ ts: 0, dur: 1, data: new Uint8Array(1) }];
const videoMp4 = { video: { info: { codec: 'avc1', video: { width: 1280, height: 720 } } } };

test('media source forwards cancellation to text and Range requests', async () => {
  const controller = new AbortController(), requests = [];
  const src = createSource(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 206, text: async () => 'test', arrayBuffer: async () => new ArrayBuffer(2) };
  });
  await src.getText('metadata', { signal: controller.signal });
  await src.getRange('media', 10, 20, { signal: controller.signal });
  assert.ok(requests.every((r) => r.options.signal === controller.signal));
  assert.equal(requests[1].options.headers.Range, 'bytes=10-20');
});

test('prefetch size limit skips oversized downloads but ordinary processing still reads the window', async () => {
  let calls = 0;
  const controller = new AbortController();
  const src = { getRange: async (_, start, end, { signal }) => { calls++; assert.equal(signal, controller.signal); return new Uint8Array(end - start + 1); } };
  const mp4 = { mediaUrl: 'media', video: null, audio: { info: { timescale: 1 }, samples: [{ cts: 0, duration: 1, offset: 0, size: 100 }] } };
  await assert.rejects(fetchWindow(src, mp4, 0, 120, { maxBytes: 32, signal: controller.signal }), { code: 'PREFETCH_LIMIT' });
  assert.equal(calls, 0);
  const result = await fetchWindow(src, mp4, 0, 120, { signal: controller.signal });
  assert.equal(calls, 1);assert.equal(result.bytes, 100);
});

test('bounded prefetch rejects HTTP 200 before reading its full body; foreground reads remain unchanged', async () => {
  let canceled = 0, reads = 0;
  const src = createSource(async () => ({ status: 200, body: { cancel() { canceled++; } }, arrayBuffer: async () => { reads++; return new ArrayBuffer(32); } }));
  await assert.rejects(src.getRange('media', 0, 3, { maxBytes: 8 }), { code: 'PREFETCH_LIMIT' });
  assert.equal(canceled, 1);assert.equal(reads, 0);
  assert.equal((await src.getRange('media', 0, 3)).length, 32);assert.equal(reads, 1);
});

test('bounded prefetch checks declared size and streamed bytes without trusting Content-Length', async () => {
  let canceled = 0, reads = 0, released = 0;
  const oversized = createSource(async () => ({ status: 206, headers: { get: () => '100' }, body: { cancel() { canceled++; }, getReader() { throw Error('must not read'); } } }));
  await assert.rejects(oversized.getRange('media', 0, 3, { maxBytes: 8 }), { code: 'PREFETCH_LIMIT' });
  const stream = createSource(async () => ({ status: 206, headers: { get: () => '4' }, body: { getReader: () => ({
    read: async () => { reads++; return { done: false, value: new Uint8Array(5) }; },
    cancel() { canceled++; }, releaseLock() { released++; },
  }) } }));
  await assert.rejects(stream.getRange('media', 0, 3, { maxBytes: 8 }), { code: 'PREFETCH_LIMIT' });
  assert.equal(reads, 2);assert.equal(canceled, 2);assert.equal(released, 1);
});

test('bounded prefetch joins valid chunks and cancellation abandons a blocked stream read', async () => {
  const chunks = [{ done: false, value: new Uint8Array([1, 2]) }, { done: false, value: new Uint8Array([3]) }, { done: true }];
  const src = createSource(async () => ({ status: 206, body: { getReader: () => ({ read: async () => chunks.shift(), releaseLock() {} }) } }));
  assert.deepEqual(await src.getRange('media', 0, 2, { maxBytes: 8 }), new Uint8Array([1, 2, 3]));
  const gate = deferred(), controller = new AbortController();let canceled = 0, released = 0;
  const blocked = createSource(async () => ({ status: 206, body: { getReader: () => ({ read: () => gate.promise, cancel() { canceled++; }, releaseLock() { released++; } }) } }));
  const pending = blocked.getRange('media', 0, 2, { maxBytes: 8, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick();controller.abort();await rejected;
  assert.equal(canceled, 1);assert.equal(released, 1);
  gate.resolve({ done: false, value: new Uint8Array(20) });await tick();
});

test('audio cancellation closes a blocked decoder and discards late AudioData', async () => {
  const gate = deferred(), controller = new AbortController();let decoder, closed = 0, copied = 0, dataClosed = 0;
  class AudioDecoder {
    constructor(options) { this.options = options;this.state = 'configured';decoder = this; }
    configure() {} decode() {} flush() { return gate.promise; } close() { this.state = 'closed';closed++; }
  }
  await withGlobals({ AudioDecoder, EncodedAudioChunk: class {} }, async () => {
    const pending = decodeAudio16k(audioMp4, audioSamples, { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    controller.abort();await rejected;assert.equal(closed, 1);
    decoder.options.output({ copyTo() { copied++; }, close() { dataClosed++; } });
    gate.resolve();await tick();assert.equal(copied, 0);assert.equal(dataClosed, 1);
  });
});

test('audio cancellation does not wait for offline rendering or expose its late result', async () => {
  const gate = deferred(), controller = new AbortController();let started = false, used = 0;
  class AudioDecoder {
    constructor(options) { this.options = options;this.state = 'configured'; }
    configure() {} decode() { this.options.output({ numberOfFrames: 2, numberOfChannels: 1, copyTo(buffer) { buffer.fill(0.5); }, close() {} }); }
    async flush() {} close() { this.state = 'closed'; }
  }
  class OfflineAudioContext {
    createBuffer() { return { copyToChannel() {} }; } createBufferSource() { return { connect() {}, start() {} }; }
    startRendering() { started = true;return gate.promise; }
  }
  await withGlobals({ AudioDecoder, OfflineAudioContext, EncodedAudioChunk: class {} }, async () => {
    const pending = decodeAudio16k(audioMp4, audioSamples, { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await tick();assert.equal(started, true);controller.abort();await rejected;
    gate.resolve({ getChannelData() { used++;return new Float32Array(1); } });await tick();assert.equal(used, 0);
  });
});

test('video cancellation closes blocked flush and disposes late bitmap and frame outputs', async () => {
  const flush = deferred(), bitmap = deferred(), controller = new AbortController();let decoder, closed = 0, frameClosed = 0, bitmapClosed = 0;
  class VideoDecoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor(options) { this.options = options;this.state = 'configured';decoder = this; }
    configure() {} decode() { this.options.output({ timestamp: 0, close() { frameClosed++; } }); }
    flush() { return flush.promise; } close() { this.state = 'closed';closed++; }
  }
  await withGlobals({ VideoDecoder, EncodedVideoChunk: class {}, createImageBitmap: () => bitmap.promise }, async () => {
    const pending = decodeKeyframes(videoMp4, [{ ts: 0, data: new Uint8Array(1) }], { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await tick();controller.abort();await rejected;assert.equal(closed, 1);
    bitmap.resolve({ close() { bitmapClosed++; } });flush.resolve();await tick();
    assert.equal(bitmapClosed, 1);assert.equal(frameClosed, 1);
    decoder.options.output({ close() { frameClosed++; } });assert.equal(frameClosed, 2);
  });
});

test('video cancellation also abandons bitmap conversion after decoder flush completes', async () => {
  const bitmap = deferred(), controller = new AbortController();let frameClosed = 0, bitmapClosed = 0, existingClosed = 0, conversions = 0;
  class VideoDecoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor(options) { this.options = options;this.state = 'configured'; }
    configure() {} decode() { this.options.output({ timestamp: 0, close() { frameClosed++; } }); }
    async flush() {} close() { this.state = 'closed'; }
  }
  await withGlobals({ VideoDecoder, EncodedVideoChunk: class {}, createImageBitmap: () => ++conversions === 1 ? Promise.resolve({ close() { existingClosed++; } }) : bitmap.promise }, async () => {
    const pending = decodeKeyframes(videoMp4, [0, 1].map(ts => ({ ts, data: new Uint8Array(1) })), { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await tick();controller.abort();await rejected;assert.equal(existingClosed, 1);
    bitmap.resolve({ close() { bitmapClosed++; } });await tick();assert.equal(frameClosed, 2);assert.equal(bitmapClosed, 1);
  });
});

test('ordinary audio and video decoding still return their output with ownership transferred to the caller', async () => {
  const samples = new Float32Array([0.25, 0.5]);let audioClosed = 0, frameClosed = 0, bitmapClosed = 0;
  class AudioDecoder {
    constructor(options) { this.options = options;this.state = 'configured'; }
    configure() {} decode() { this.options.output({ numberOfFrames: 2, numberOfChannels: 1, copyTo(buffer) { buffer.set(samples); }, close() { audioClosed++; } }); }
    async flush() {} close() { this.state = 'closed'; }
  }
  class OfflineAudioContext {
    createBuffer() { return { copyToChannel() {} }; } createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { return { getChannelData: () => samples }; }
  }
  class VideoDecoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor(options) { this.options = options;this.state = 'configured'; }
    configure() {} decode() { this.options.output({ timestamp: 1e6, close() { frameClosed++; } }); }
    async flush() {} close() { this.state = 'closed'; }
  }
  await withGlobals({ AudioDecoder, OfflineAudioContext, VideoDecoder, EncodedAudioChunk: class {}, EncodedVideoChunk: class {}, createImageBitmap: async () => ({ close() { bitmapClosed++; } }) }, async () => {
    assert.equal(await decodeAudio16k(audioMp4, audioSamples), samples);
    const frames = await decodeKeyframes(videoMp4, [{ ts: 1, data: new Uint8Array(1) }]);
    assert.equal(frames[0].ts, 1);assert.equal(audioClosed, 1);assert.equal(frameClosed, 1);assert.equal(bitmapClosed, 0);
    frames[0].bitmap.close();assert.equal(bitmapClosed, 1);
  });
});
