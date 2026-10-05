// Remote-only ASR. No SDK, local model, automatic retry, or provider response logging.
export const GROQ_MODEL = 'whisper-large-v3-turbo';
export const MAX_GROQ_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_GROQ_RESPONSE_BYTES = 2 * 1024 * 1024;
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const REQUEST_TIMEOUT_MS = 120_000;
const END_TIMESTAMP_TICK_SECONDS = 0.020;
const encoder = new TextEncoder();

export class GroqError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GroqError';
    this.code = code;
    if (Number.isFinite(details.retryAt)) this.retryAt = details.retryAt;
    if (Number.isFinite(details.retryAfter)) this.retryAfter = details.retryAfter;
  }
}

function failure(code, message) { throw new GroqError(code, message); }
function abortError() { return new DOMException('Groq 전사를 취소했습니다.', 'AbortError'); }
function validateKey(apiKey) {
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(apiKey)) {
    failure('GROQ_AUTH', 'Groq API 키를 설정하거나 다시 확인하세요.');
  }
  return apiKey;
}

function decodeAudio(audioB64) {
  // Bound the string before regex/decode; canonical padded base64 only (no data URL).
  if (typeof audioB64 !== 'string') failure('GROQ_INPUT', '오디오 형식이 잘못되었습니다.');
  if (audioB64.length > 4 * Math.ceil(MAX_GROQ_AUDIO_BYTES / 3)) {
    failure('GROQ_INPUT_SIZE', '전사 오디오는 10 MiB 이하여야 합니다.');
  }
  if (!audioB64.length || audioB64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audioB64)) {
    failure('GROQ_INPUT', '오디오 base64 형식이 잘못되었습니다.');
  }
  let binary;
  try { binary = atob(audioB64); } catch { failure('GROQ_INPUT', '오디오 base64 형식이 잘못되었습니다.'); }
  if (binary.length > MAX_GROQ_AUDIO_BYTES) failure('GROQ_INPUT_SIZE', '전사 오디오는 10 MiB 이하여야 합니다.');
  // atob accepts noncanonical padding bits; reject those too.
  if (btoa(binary) !== audioB64) failure('GROQ_INPUT', '오디오 base64 형식이 잘못되었습니다.');
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') {
    failure('GROQ_INPUT', 'M4A 오디오 파일이 필요합니다.');
  }
  const headerSize = new DataView(bytes.buffer).getUint32(0);
  if (headerSize < 16 || headerSize > bytes.length) failure('GROQ_INPUT', 'M4A 파일 헤더가 잘못되었습니다.');
  return bytes;
}

function requestSignal(signal) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(abortError());
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    check() {
      if (signal?.aborted) throw abortError();
      if (timedOut) failure('GROQ_TRANSIENT', 'Groq 전사 요청 시간이 초과되었습니다. 다시 시도하세요.');
    },
    cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

function retryDetails(header) {
  const now = Date.now();
  const value = typeof header === 'string' ? header.trim() : '';
  let retryAt;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && Number.isFinite(now + seconds * 1000)) retryAt = now + seconds * 1000;
  } else if (value && !/^[-+]?\d+(?:\.\d+)?$/.test(value)) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) retryAt = Math.max(now, date);
  }
  return retryAt === undefined ? {} : { retryAt, retryAfter: Math.max(0, Math.ceil((retryAt - now) / 1000)) };
}

async function boundedJSON(response, scope) {
  const advertised = response.headers?.get('content-length');
  if (advertised && Number(advertised) > MAX_GROQ_RESPONSE_BYTES) {
    failure('GROQ_RESPONSE', 'Groq 전사 응답이 너무 큽니다.');
  }
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        scope.check();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_GROQ_RESPONSE_BYTES) failure('GROQ_RESPONSE', 'Groq 전사 응답이 너무 큽니다.');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { failure('GROQ_RESPONSE', 'Groq 전사 응답 인코딩이 잘못되었습니다.'); }
    } finally {
      try { await reader.cancel(); } catch {}
      reader.releaseLock();
    }
  } else {
    text = await response.text();
    if (encoder.encode(text).byteLength > MAX_GROQ_RESPONSE_BYTES) failure('GROQ_RESPONSE', 'Groq 전사 응답이 너무 큽니다.');
  }
  scope.check();
  try { return JSON.parse(text); } catch { failure('GROQ_RESPONSE', 'Groq 전사 응답 형식이 잘못되었습니다.'); }
}

function parseSegments(result, offset, duration) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      (result.text !== undefined && typeof result.text !== 'string')) {
    failure('GROQ_RESPONSE', 'Groq 전사 응답 형식이 잘못되었습니다.');
  }
  if (!Array.isArray(result.segments)) {
    if (typeof result.text === 'string' && !result.text.trim() && result.segments === undefined) return [];
    failure('GROQ_RESPONSE', 'Groq 전사 응답에 구간별 시간이 없습니다.');
  }
  const segments = [];
  let lastStart = -1, lastEnd = -1;
  for (const segment of result.segments) {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment) || typeof segment.text !== 'string') {
      failure('GROQ_RESPONSE', 'Groq 전사 구간 형식이 잘못되었습니다.');
    }
    // Silence is the only segment that may be discarded.
    if (!segment.text.trim()) continue;
    const { start, end } = segment;
    // Whisper timestamps use 20ms ticks; an end tick can round beyond the final AAC sample.
    const normalizedEnd = Math.min(end, duration);
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) ||
        start < 0 || start >= duration || end <= start || end > duration + END_TIMESTAMP_TICK_SECONDS ||
        normalizedEnd <= start || start < lastStart || end < lastEnd ||
        !Number.isFinite(offset + start) || !Number.isFinite(offset + normalizedEnd) || offset + normalizedEnd <= offset + start) {
      failure('GROQ_RESPONSE', 'Groq 전사 구간 시간이 오디오 범위를 벗어났거나 잘못되었습니다.');
    }
    segments.push({ start: offset + start, end: offset + normalizedEnd, text: segment.text.trim() });
    lastStart = start;
    lastEnd = end;
  }
  if (!segments.length && result.text?.trim()) failure('GROQ_RESPONSE', 'Groq 전사 텍스트에 대응하는 구간별 시간이 없습니다.');
  return segments;
}

export async function transcribeGroq({ audioB64, offset = 0, duration, apiKey, signal, fetchImpl = globalThis.fetch } = {}) {
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    failure('GROQ_INPUT', '전사 취소 신호 형식이 잘못되었습니다.');
  }
  if (signal?.aborted) throw abortError();
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0 ||
      typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 121 ||
      !Number.isFinite(offset + duration) || offset + duration <= offset) {
    failure('GROQ_INPUT', '전사 구간은 유효한 시작 시간과 121초 이하 길이가 필요합니다.');
  }
  const key = validateKey(apiKey);
  const bytes = decodeAudio(audioB64);
  if (typeof fetchImpl !== 'function') failure('GROQ_TRANSIENT', 'Groq 요청을 실행할 수 없습니다.');
  const body = new FormData();
  body.append('file', new Blob([bytes], { type: 'audio/mp4' }), 'lecture.m4a');
  body.append('model', GROQ_MODEL);
  body.append('language', 'ko');
  body.append('response_format', 'verbose_json');
  body.append('timestamp_granularities[]', 'segment');
  body.append('temperature', '0');
  const scope = requestSignal(signal);
  try {
    scope.check();
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body,
      signal: scope.signal, redirect: 'error',
    });
    scope.check();
    if (!response.ok) {
      // Never read/reflect error bodies: they can contain credentials or submitted content.
      try { await response.body?.cancel(); } catch {}
      if (response.status === 429) throw new GroqError('GROQ_RATE_LIMIT', 'Groq 사용 한도에 도달했습니다. 안내된 시간 이후 다시 시도하세요.', retryDetails(response.headers?.get('retry-after')));
      if (response.status === 401 || response.status === 403) failure('GROQ_AUTH', 'Groq API 키를 설정하거나 다시 확인하세요.');
      if (response.status === 413) failure('GROQ_INPUT_SIZE', 'Groq에서 오디오 크기 제한을 초과했습니다.');
      if (response.status >= 500 || response.status === 408) failure('GROQ_TRANSIENT', 'Groq 서버에 일시적인 문제가 있습니다. 다시 시도하세요.');
      failure('GROQ_REQUEST', 'Groq 전사 요청을 처리할 수 없습니다. 오디오와 설정을 확인하세요.');
    }
    const result = await boundedJSON(response, scope);
    return { segments: parseSegments(result, offset, duration), model: GROQ_MODEL, provider: 'groq' };
  } catch (error) {
    scope.check();
    if (error instanceof GroqError) throw error;
    if (error?.name === 'AbortError') throw abortError();
    failure('GROQ_TRANSIENT', 'Groq에 연결하거나 응답을 읽을 수 없습니다. 다시 시도하세요.');
  } finally { scope.cleanup(); }
}

export async function testGroqConnection({ apiKey, signal, fetchImpl = globalThis.fetch } = {}) {
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    failure('GROQ_INPUT', 'Groq 연결 확인 취소 신호 형식이 잘못되었습니다.');
  }
  if (signal?.aborted) throw abortError();
  const key = validateKey(apiKey);
  if (typeof fetchImpl !== 'function') failure('GROQ_TRANSIENT', 'Groq 요청을 실행할 수 없습니다.');
  const scope = requestSignal(signal);
  try {
    scope.check();
    const response = await fetchImpl('https://api.groq.com/openai/v1/models', {
      method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: scope.signal, redirect: 'error',
    });
    scope.check();
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      if (response.status === 429) throw new GroqError('GROQ_RATE_LIMIT', 'Groq 사용 한도에 도달했습니다. 안내된 시간 이후 다시 시도하세요.', retryDetails(response.headers?.get('retry-after')));
      if (response.status === 401 || response.status === 403) failure('GROQ_AUTH', 'Groq API 키를 설정하거나 다시 확인하세요.');
      if (response.status >= 500 || response.status === 408) failure('GROQ_TRANSIENT', 'Groq 서버에 일시적인 문제가 있습니다. 다시 시도하세요.');
      failure('GROQ_REQUEST', 'Groq 연결 확인 요청을 처리할 수 없습니다.');
    }
    const result = await boundedJSON(response, scope);
    if (!result || !Array.isArray(result.data) || result.data.some(model => !model || typeof model.id !== 'string')) {
      failure('GROQ_RESPONSE', 'Groq 모델 목록 응답 형식이 잘못되었습니다.');
    }
    if (!result.data.some(model => model.id === GROQ_MODEL && model.active !== false)) {
      failure('GROQ_MODEL_UNAVAILABLE', 'Groq 계정에서 선택한 전사 모델을 사용할 수 없습니다.');
    }
    return { provider: 'groq', model: GROQ_MODEL, available: true };
  } catch (error) {
    scope.check();
    if (error instanceof GroqError) throw error;
    if (error?.name === 'AbortError') throw abortError();
    failure('GROQ_TRANSIENT', 'Groq에 연결하거나 응답을 읽을 수 없습니다. 다시 시도하세요.');
  } finally { scope.cleanup(); }
}

// Node-only credential storage imports are deferred so the transcription adapter
// itself can also be imported in a browser. Only privileged host code calls this.
export function createGroqConfigStore({ file, env = globalThis.process?.env || {} } = {}) {
  if (typeof file !== 'string' || !file) failure('GROQ_CONFIG', 'Groq 설정 파일 경로가 필요합니다.');
  let writeQueue = Promise.resolve();
  async function read() {
    const fs = await import('node:fs/promises');
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 4096) failure('GROQ_CONFIG', 'Groq 설정 파일 형식이 잘못되었습니다.');
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      return { apiKey: validateKey(parsed?.apiKey), source: 'file' };
    } catch (error) {
      if (error?.code !== 'ENOENT') failure('GROQ_CONFIG', 'Groq 설정 파일을 읽을 수 없습니다. 키를 다시 저장하세요.');
    }
    if (env.GROQ_API_KEY) return { apiKey: validateKey(env.GROQ_API_KEY), source: 'environment' };
    return { apiKey: null, source: null };
  }
  function queued(operation) {
    const pending = writeQueue.then(operation);
    writeQueue = pending.catch(() => {});
    return pending;
  }
  async function status() {
    await writeQueue;
    const { apiKey, source } = await read();
    return { configured: !!apiKey, source };
  }
  return {
    status,
    async get() { await writeQueue; return (await read()).apiKey; },
    save(apiKey) {
      return queued(async () => {
        validateKey(apiKey);
        const fs = await import('node:fs/promises');
        const { dirname, join } = await import('node:path');
        const { randomUUID } = await import('node:crypto');
        const temporary = join(dirname(file), `.groq-${randomUUID()}.tmp`);
        try {
          await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
          await fs.writeFile(temporary, JSON.stringify({ apiKey }) + '\n', { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, file);
          if (globalThis.process?.platform !== 'win32') await fs.chmod(file, 0o600);
        } catch {
          failure('GROQ_CONFIG', 'Groq API 키를 저장할 수 없습니다.');
        } finally { try { await fs.unlink(temporary); } catch {} }
        return { configured: true, source: 'file' };
      });
    },
    remove() {
      return queued(async () => {
        const fs = await import('node:fs/promises');
        try { await fs.unlink(file); } catch (error) {
          if (error?.code !== 'ENOENT') failure('GROQ_CONFIG', 'Groq API 키를 삭제할 수 없습니다.');
        }
        const { apiKey, source } = await read();
        return { configured: !!apiKey, source };
      });
    },
  };
}
