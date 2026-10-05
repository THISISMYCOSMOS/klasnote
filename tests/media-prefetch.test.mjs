import test from 'node:test';
import assert from 'node:assert/strict';
import { createSource, fetchWindow, decodeKeyframes } from '../extension/src/core/media.js';

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

// decodeKeyframes draws each frame into one CPU canvas (willReadFrequently) and transfers it out, instead of
// createImageBitmap(VideoFrame), which grew the GPU process by 400-700 MB per window on 2026-10-05.
function cpuCanvas({ onBitmap = () => ({ close() {} }), onDraw = () => {}, contexts = [] } = {}) {
  return class OffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext(type, options) { contexts.push(options); return { drawImage: (...args) => onDraw(...args) }; }
    transferToImageBitmap() { return onBitmap(); }
  };
}

test('video cancellation closes blocked flush and disposes frame outputs and bitmaps', async () => {
  const flush = deferred(), controller = new AbortController();let decoder, closed = 0, frameClosed = 0, bitmapClosed = 0;
  class VideoDecoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor(options) { this.options = options;this.state = 'configured';decoder = this; }
    configure() {} decode() { this.options.output({ timestamp: 0, close() { frameClosed++; } }); }
    flush() { return flush.promise; } close() { this.state = 'closed';closed++; }
  }
  const contexts = [];
  await withGlobals({ VideoDecoder, EncodedVideoChunk: class {}, OffscreenCanvas: cpuCanvas({ contexts, onBitmap: () => ({ close() { bitmapClosed++; } }) }) }, async () => {
    const pending = decodeKeyframes(videoMp4, [{ ts: 0, data: new Uint8Array(1) }], { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await tick();controller.abort();await rejected;assert.equal(closed, 1);
    flush.resolve();await tick();
    assert.equal(bitmapClosed, 1);assert.equal(frameClosed, 1);
    decoder.options.output({ close() { frameClosed++; } });assert.equal(frameClosed, 2);
    assert.deepEqual(contexts, [{ willReadFrequently: true }], 'frames are drawn on a CPU canvas, not the GPU');
  });
});

test('a frame that cannot be drawn rejects and releases every frame and earlier bitmap', async () => {
  let frameClosed = 0, existingClosed = 0, draws = 0;
  class VideoDecoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor(options) { this.options = options;this.state = 'configured'; }
    configure() {} decode() { this.options.output({ timestamp: 0, close() { frameClosed++; } }); }
    async flush() {} close() { this.state = 'closed'; }
  }
  const OffscreenCanvas = cpuCanvas({ onDraw: () => { if (++draws === 2) throw new Error('draw failed'); }, onBitmap: () => ({ close() { existingClosed++; } }) });
  await withGlobals({ VideoDecoder, EncodedVideoChunk: class {}, OffscreenCanvas }, async () => {
    await assert.rejects(decodeKeyframes(videoMp4, [0, 1].map(ts => ({ ts, data: new Uint8Array(1) }))), /draw failed/);
    assert.equal(frameClosed, 2);assert.equal(existingClosed, 1);
  });
});

test('streaming video emits one bitmap at a time and preserves caller ownership',async()=>{
  let open=0,peak=0,framesClosed=0,received=0;
  class VideoDecoder{static async isConfigSupported(){return {supported:true};}constructor(o){this.o=o;this.state='configured';}configure(){}decode(k){this.o.output({timestamp:k.timestamp,close(){framesClosed++;}});}async flush(){}close(){this.state='closed';}}
  const OffscreenCanvas=cpuCanvas({onBitmap:()=>{open++;peak=Math.max(peak,open);return {close(){open--;}};}});
  await withGlobals({VideoDecoder,EncodedVideoChunk:class{constructor(o){Object.assign(this,o);}},OffscreenCanvas},async()=>{
    const frames=Array.from({length:60},(_,ts)=>({ts,data:new Uint8Array(1)}));
    const out=await decodeKeyframes(videoMp4,frames,{onFrame:async frame=>{received++;await tick();frame.bitmap.close();}});
    assert.equal(received,60);assert.equal(framesClosed,60);assert.equal(peak,1);assert.equal(open,0);assert.deepEqual(out,[]);
  });
});
