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
let pending = Promise.resolve();

// 모델 로드·전사·해제를 같은 순서로 실행한다. idle 해제도 진행 중인 전사의 마지막 조각까지 기다린다.
function exclusive(fn) {
  const result = pending.then(fn);
  pending = result.catch(() => {}); // 해제 실패가 이후 모든 로드를 계속 실패시키지 않게 한다.
  return result;
}

async function releaseCurrent() {
  const previous = cached;
  cached = null;
  if (previous) await previous.asr.dispose();
}

export function releaseAsr() {
  return exclusive(releaseCurrent);
}

export function loadAsr(modelKey = 'base', onProgress, decoderDtype) {
  return exclusive(async () => {
    const id = MODELS[modelKey] ?? modelKey;
    // base는 GPU decoder의 fp16 정밀도를 기본으로 쓰고, 더 큰 small은 q4를 유지한다.
    decoderDtype ??= id === MODELS.base ? 'fp16' : 'q4';
    if (cached?.id === id && cached.decoderDtype === decoderDtype) return cached;
    await releaseCurrent();
    const hasGpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null)));
    const device = hasGpu ? 'webgpu' : 'wasm';
    const dtype = hasGpu ? { encoder_model: 'fp16', decoder_model_merged: decoderDtype } : 'q8';
    const asr = await pipeline('automatic-speech-recognition', id, { device, dtype, progress_callback: onProgress });
    cached = { id, device, asr, decoderDtype };
    return cached;
  });
}

const SR = 16000;
// Whisper의 448 토큰 문맥에서 언어/작업 prefix 공간을 남긴다. 명시한 한도는
// Transformers 4.3의 timestamp seek 루프를 건너뛴다(오디오는 아래에서 이미 나눈다).
const MAX_NEW_TOKENS = 440;

// 한도 때문에 잘린 문장을 정상 전사로 저장하지 않도록 관찰만 한다.
class GenerationObserver {
  constructor(eos) {
    this.eos = Array.isArray(eos) ? eos : [eos];
    this.prompt = true;
    this.tokens = 0;
    this.exhausted = false;
  }
  // generate()는 prompt를 먼저 보낸 뒤 새 토큰들을 보낸다. 4.3 Whisper는
  // single-pass에서 사용자 stopping_criteria를 전달하지 않아 streamer로 관찰한다.
  put(inputIds) {
    if (this.prompt) { this.prompt = false; return; }
    const ids = inputIds[0];
    this.tokens += ids.length;
    const ended = this.eos.some((id) => id != null && Number(ids.at(-1)) === Number(id));
    this.exhausted = this.tokens >= MAX_NEW_TOKENS && !ended;
  }
  end() {}
}

// 수백 번 이어진 같은 구절 같은 명확한 생성 루프만 재시도한다.
// 발화는 수정하지 않는다. 공백/문장부호 정규화는 탐지에만 사용한다.
function hasPathologicalRepetition(result) {
  const texts = [result.text ?? '', (result.chunks ?? []).map((c) => c.text ?? '').join(' ')];
  return texts.some((text) => {
    const normalized = text.replace(/[\s.,!?…·，。！？]/gu, '');
    if (normalized.length < 160) return false;
    for (const match of normalized.matchAll(/(.{2,80}?)\1{23,}/gu)) {
      if (match[0].length >= 160 && match[0].length >= normalized.length / 2) return true;
    }
    return false;
  });
}

async function recognize(asr, pcm, recoverRepetition = false) {
  const observer = new GenerationObserver(asr.model?.generation_config?.eos_token_id ?? asr.tokenizer?.eos_token_id);
  const result = await asr(pcm, {
    language: 'korean', task: 'transcribe', return_timestamps: true,
    max_new_tokens: MAX_NEW_TOKENS, streamer: observer,
    // 실제 반복 실패의 복구 때만 6토큰 연속 재생성을 막는다. 정상 전사와
    // 생성 한도만 넘긴 재시도에는 발화 반복을 제한하지 않는다.
    ...(recoverRepetition ? { no_repeat_ngram_size: 6 } : {}),
  });
  return { result, problem: hasPathologicalRepetition(result) ? 'ASR_REPETITION' : observer.exhausted ? 'ASR_GENERATION_LIMIT' : null };
}

function appendChunks(out, result, base, duration) {
  const chunks = result.chunks?.length ? result.chunks : [{ timestamp: [0, duration], text: result.text }];
  for (const chunk of chunks) {
    const text = (chunk.text ?? '').trim();
    if (!text) continue;
    const [from, to] = chunk.timestamp ?? [];
    const start = Math.max(0, Math.min(duration, Number.isFinite(from) ? from : 0));
    const end = Math.max(start, Math.min(duration, Number.isFinite(to) ? to : duration));
    out.push({ start: base + start, end: base + end, text });
  }
}

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
export function transcribe(model, pcm, offset = 0) {
  return exclusive(async () => {
    if (!model || model !== cached) throw new Error('해제되었거나 교체된 받아쓰기 모델입니다.');
    const { asr } = model;
    const out = [];
    for (const [a, b] of splitAtQuiet(pcm)) {
      const first = await recognize(asr, pcm.subarray(a, b));
      if (!first.problem) {
        appendChunks(out, first.result, offset + a / SR, (b - a) / SR);
        continue;
      }
      // 같은 모델로 정확히 두 반쪽만 다시 받는다. 겹침/삭제 없이 모든 샘플을
      // 포함하고 재귀 재시도는 하지 않는다(원래 조각당 최대 3회 호출).
      const mid = a + Math.floor((b - a) / 2);
      for (const [start, end] of [[a, mid], [mid, b]]) {
        const retry = await recognize(asr, pcm.subarray(start, end), first.problem === 'ASR_REPETITION');
        if (retry.problem) {
          const error = new Error(retry.problem === 'ASR_REPETITION'
            ? '짧은 구간 재시도에도 받아쓰기에서 과도한 반복이 발생했습니다. 이 구간은 저장하지 않았습니다.'
            : '짧은 구간 재시도에도 받아쓰기 생성 한도에 도달했습니다. 미완성 구간은 저장하지 않았습니다.');
          error.code = retry.problem;
          throw error;
        }
        appendChunks(out, retry.result, offset + start / SR, (end - start) / SR);
      }
    }
    return out;
  });
}
