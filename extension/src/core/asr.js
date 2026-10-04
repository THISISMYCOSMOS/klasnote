// 브라우저 안에서 Whisper로 받아쓴다(WebGPU 우선, 안 되면 WASM). 모델은 처음 한 번 받고 브라우저 캐시에 둔다.
import { pipeline, env } from '../../vendor/transformers.js';

// MV3는 원격 스크립트를 막으므로 ONNX Runtime wasm을 확장 안의 파일로 지정한다.
const vendor = new URL('../../vendor/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = {
  mjs: vendor + 'ort-wasm-simd-threaded.asyncify.mjs',
  wasm: vendor + 'ort-wasm-simd-threaded.asyncify.wasm',
};
env.allowLocalModels = false;

// turbo(large-v3-turbo)는 메모리 16GB 내장 GPU PC에서 std::bad_alloc으로 실패해 제외했다(실측).
export const MODELS = {
  small: 'onnx-community/whisper-small',
  base: 'onnx-community/whisper-base',
};

let cached = null;
let releasing = Promise.resolve();

export async function releaseAsr() {
  const previous = cached;
  cached = null;
  if (previous) releasing = releasing.then(() => previous.asr.dispose());
  await releasing;
}

export async function loadAsr(modelKey = 'small', onProgress, decoderDtype = 'q4') {
  const id = MODELS[modelKey] ?? modelKey;
  if (cached?.id === id) return cached;
  await releaseAsr();
  const hasGpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null)));
  const device = hasGpu ? 'webgpu' : 'wasm';
  const dtype = hasGpu ? { encoder_model: 'fp16', decoder_model_merged: decoderDtype } : 'q8';
  const asr = await pipeline('automatic-speech-recognition', id, { device, dtype, progress_callback: onProgress });
  cached = { id, device, asr };
  return cached;
}

const SR = 16000;

// 30초 이하 조각으로 자르되, 22~29초 사이에서 가장 조용한 지점을 경계로 쓴다.
// Whisper 자체 겹침(stride) 병합은 경계에서 문장이 중복되는 문제가 있어 쓰지 않는다(실측).
export function splitAtQuiet(pcm, { min = 22, max = 29, win = 0.2 } = {}) {
  const pieces = [];
  let s = 0;
  while (pcm.length - s > max * SR) {
    let best = s + max * SR, bestE = Infinity;
    const w = Math.round(win * SR);
    for (let p = s + min * SR; p + w <= s + max * SR; p += w) {
      let e = 0;
      for (let i = p; i < p + w; i++) e += pcm[i] * pcm[i];
      if (e < bestE) { bestE = e; best = p + (w >> 1); }
    }
    pieces.push([s, best]);
    s = best;
  }
  if (pcm.length - s > SR * 0.5) pieces.push([s, pcm.length]);
  return pieces;
}

// pcm: 16kHz 모노. offset: 이 구간이 강의 전체에서 시작하는 초. 반환 [{start, end, text}]
export async function transcribe({ asr }, pcm, offset = 0) {
  const out = [];
  for (const [a, b] of splitAtQuiet(pcm)) {
    const r = await asr(pcm.subarray(a, b), { language: 'korean', task: 'transcribe', return_timestamps: true });
    const base = offset + a / SR;
    for (const c of r.chunks ?? [{ timestamp: [0, (b - a) / SR], text: r.text }]) {
      const text = c.text.trim();
      if (!text) continue;
      out.push({ start: base + (c.timestamp[0] ?? 0), end: base + (c.timestamp[1] ?? (b - a) / SR), text });
    }
  }
  return out;
}
