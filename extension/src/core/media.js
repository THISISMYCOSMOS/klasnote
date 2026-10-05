// kwcommons 강의 mp4에서 압축 AAC와 키프레임(슬라이드 후보)을 뽑는다.
// 전제(실측 31강): progressive mp4, H.264 + AAC(44.1/48kHz), 키프레임 약 2초 간격. moov 위치는 앞·끝 모두 있음.
// 전역 MP4Box(vendor/mp4box.all.js)가 먼저 로드되어 있어야 한다.

const KW = 'https://kwcommons.kw.ac.kr';

const abortError = (signal) => signal?.reason ?? Object.assign(new Error('사용자가 중지함'), { name: 'AbortError' });
function checkAbort(signal) { if (signal?.aborted) throw abortError(signal); }
// 디코더와 렌더러가 늦게 끝나더라도 취소된 강의의 큐를 붙잡지 않는다.
function abortable(promise, signal, onAbort) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { try { onAbort?.(); } catch {} finish(reject, abortError(signal)); };
    const finish = (settle, value) => { signal.removeEventListener('abort', abort); settle(value); };
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
const prefetchLimit = () => Object.assign(new Error('다음 구간 미리 받기 메모리 한도'), { code: 'PREFETCH_LIMIT' });
function discardBody(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }

// fetchImpl(url, init)을 주입받는다. 확장에서는 fetch, 개발 서버에서는 프록시 fetch.
export function createSource(fetchImpl = fetch) {
  async function getText(url, { signal } = {}) {
    const r = await fetchImpl(url, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return r.text();
  }
  async function getRange(url, start, endInclusive, { signal, maxBytes = Infinity } = {}) {
    const r = await fetchImpl(url, { headers: { Range: `bytes=${start}-${endInclusive}` }, signal });
    if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status} range ${url}`);
    if (Number.isFinite(maxBytes)) {
      // Range를 무시한 서버의 전체 파일은 미리 받지 않는다. 본문을 읽기 전에 버린다.
      if (r.status !== 206 || Number(r.headers?.get('content-length')) > maxBytes || !r.body?.getReader) {
        discardBody(r.body);
        throw prefetchLimit();
      }
      const reader = r.body.getReader(), parts = [];
      let size = 0, done = false, canceled = false;
      const cancel = () => { if (canceled) return; canceled = true;try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
      try {
        while (true) {
          checkAbort(signal);
          const chunk = await abortable(reader.read(), signal, cancel);
          checkAbort(signal);
          if (chunk.done) { done = true; break; }
          size += chunk.value.byteLength;
          if (size > maxBytes) throw prefetchLimit();
          parts.push(chunk.value);
        }
        const buf = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) { buf.set(part, offset); offset += part.byteLength; }
        return buf;
      } finally { if (!done) cancel(); reader.releaseLock(); }
    }
    return new Uint8Array(await r.arrayBuffer());
  }
  return { getText, getRange };
}

// content_id → 제목, 길이, mp4 주소
export async function loadContentInfo(src, contentId) {
  const xml = await src.getText(`${KW}/viewer/ssplayer/uniplayer_support/content.php?content_id=${encodeURIComponent(contentId)}`);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const q = (sel) => doc.querySelector(sel)?.textContent?.trim() ?? '';
  const title = q('content_metadata > title');
  const duration = Number(q('content_playing_info > content_duration')) || 0;
  // 형식 1(upf): story의 main_media 파일명 + service_root의 progressive 주소 템플릿
  // 형식 2(video1): main_media > desktop|mobile > html5 안에 method=progressive와 완성된 media_uri (실측 2026-10-04)
  let mediaUrl = null;
  const html5 = [...doc.querySelectorAll('main_media desktop html5, main_media mobile html5')]
    .find((n) => n.querySelector('method')?.textContent?.trim() === 'progressive');
  if (html5) mediaUrl = html5.querySelector('media_uri')?.textContent?.trim() || null;
  if (!mediaUrl) {
    const list = doc.querySelector('main_media_list');
    const def = list?.getAttribute('default_media_id');
    const file = (def && list.querySelector(`main_media[media_id="${CSS.escape(def)}"]`)?.textContent?.trim())
      || doc.querySelector('main_media_list main_media')?.textContent?.trim();
    const tpl = [...doc.querySelectorAll('service_root media_uri')]
      .find((n) => n.getAttribute('method') === 'progressive')?.textContent?.trim();
    if (file && tpl && !/[/\\]/.test(file)) mediaUrl = tpl.replace('[MEDIA_FILE]', file);
  }
  if (!mediaUrl || !mediaUrl.startsWith(`${KW}/`) || !/\.mp4(\?|$)/i.test(mediaUrl)) {
    throw new Error('지원하지 않는 콘텐츠 형식입니다 (progressive mp4 없음).');
  }
  return { contentId, title, duration, mediaUrl };
}

// 최상위 박스를 머리(최대 16바이트)만 읽으며 건너뛰어 ftyp와 moov 위치를 찾는다.
// 실측(2026-10-04, 31강): screen.mp4는 moov가 앞(faststart), ssmovie.mp4는 moov가 파일 끝에 있다. 둘 다 지원한다.
const MAX_MOOV = 64 * 1024 * 1024;
async function locateBoxes(src, url) {
  const head = await src.getRange(url, 0, 65535, {maxBytes:65536});
  const readHeader = async (off) => {
    if (off + 16 <= head.length) return head.subarray(off, off + 16);
    const h = await src.getRange(url, off, off + 15, {maxBytes:16});
    return h.length >= 8 ? h : null;
  };
  let off = 0, ftyp = null;
  for (let i = 0; i < 64; i++) {
    const h = await readHeader(off);
    if (!h) break;
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(...h.subarray(4, 8));
    if (size === 1) {
      if (h.length < 16) break;
      size = Number(dv.getBigUint64(8)); // 64비트 크기(긴 mdat)
    } else if (size === 0) {
      break; // 파일 끝까지 이어지는 박스. 그 뒤에 moov가 있을 수 없다.
    }
    if (size < 8 || !Number.isSafeInteger(off + size)) break;
    if (type === 'ftyp' && off + size <= head.length) ftyp = head.slice(off, off + size);
    if (type === 'moov') {
      if (size > MAX_MOOV) throw new Error('moov가 너무 큽니다.');
      const moov = off + size <= head.length ? head.slice(off, off + size) : await src.getRange(url, off, off + size - 1, {maxBytes:MAX_MOOV});
      if (moov.length !== size) throw new Error('moov를 끝까지 받지 못했습니다.');
      return { ftyp, moov };
    }
    off += size;
  }
  throw new Error('moov를 찾지 못했습니다 (지원하지 않는 mp4 구조).');
}

// ftyp+moov만 받아 트랙과 샘플 표를 만든다. 샘플 위치(stco/co64)는 원래 파일 기준 절대 위치라
// moov가 파일 끝에 있어도 [ftyp][moov]를 이어 붙여 해석하면 그대로 쓸 수 있다.
export async function openMp4(src, mediaUrl) {
  const { ftyp, moov } = await locateBoxes(src, mediaUrl);
  const joined = new Uint8Array((ftyp?.length || 0) + moov.length);
  if (ftyp) joined.set(ftyp, 0);
  joined.set(moov, ftyp?.length || 0);

  const file = MP4Box.createFile(false);
  const info = await new Promise((resolve, reject) => {
    file.onReady = resolve;
    file.onError = reject;
    const ab = joined.buffer;
    ab.fileStart = 0;
    file.appendBuffer(ab);
    file.flush();
  });
  const vInfo = info.tracks.find((t) => t.video);
  const aInfo = info.tracks.find((t) => t.audio);
  if (!aInfo) throw new Error('오디오 트랙이 없어 받아쓸 수 없습니다.');
  const aTrak = file.getTrackById(aInfo.id);
  const vTrak = vInfo ? file.getTrackById(vInfo.id) : null;
  return {
    mediaUrl,
    duration: info.duration / info.timescale,
    // 비디오가 없는 강의(음성만)는 슬라이드 없이 받아쓰기만 한다.
    video: vTrak ? { info: vInfo, samples: vTrak.samples, description: codecDescription(vTrak) } : null,
    audio: { info: aInfo, samples: aTrak.samples, description: aacDescription(aTrak) },
  };
}

function codecDescription(trak) {
  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  box.write(ds);
  return new Uint8Array(ds.buffer, 8); // 박스 헤더 8바이트 제외
}

function aacDescription(trak) {
  const esds = trak.mdia.minf.stbl.stsd.entries[0].esds;
  const dsi = esds?.esd?.descs?.[0]?.descs?.[0]?.data;
  return dsi ? new Uint8Array(dsi) : undefined;
}

const sec = (s, track) => s.cts / track.info.timescale;

// [t0, t1) 구간을 한 번의 Range 요청으로 받아 오디오 샘플과 키프레임 샘플을 잘라낸다.
// slideEvery: 키프레임을 몇 초 간격으로 쓸지 (슬라이드 감지 해상도)
export async function fetchWindow(src, mp4, t0, t1, { slideEvery = 2, signal, maxBytes = Infinity } = {}) {
  const aS = mp4.audio.samples.filter((s) => { const t = sec(s, mp4.audio); return t >= t0 && t < t1; });
  const vS = [];
  let next = t0;
  for (const s of mp4.video?.samples ?? []) {
    if (!s.is_sync) continue;
    const t = sec(s, mp4.video);
    if (t < t0 || t >= t1) continue;
    if (t >= next) { vS.push(s); next = t + slideEvery; }
  }
  const all = aS.concat(vS);
  if (!all.length) return { audio: [], keyframes: [], bytes: 0 };
  const start = Math.min(...all.map((s) => s.offset));
  const end = Math.max(...all.map((s) => s.offset + s.size));
  if (end - start > maxBytes) throw prefetchLimit();
  const buf = await src.getRange(mp4.mediaUrl, start, end - 1, { signal, maxBytes });
  const cut = (s) => buf.subarray(s.offset - start, s.offset - start + s.size);
  return {
    audio: aS.map((s) => ({ ts: sec(s, mp4.audio), dur: s.duration / mp4.audio.info.timescale, data: cut(s) })),
    keyframes: vS.map((s) => ({ ts: sec(s, mp4.video), data: cut(s) })),
    bytes: buf.length,
  };
}

// 키프레임 → { ts, bitmap } (가로 maxWidth로 축소)
export async function decodeKeyframes(mp4, keyframes, { maxWidth = 1280, signal, onFrame } = {}) {
  checkAbort(signal);
  const out = [];
  if (!mp4.video || !keyframes.length) return out;
  const { width, height } = mp4.video.info.video;
  const scale = Math.min(1, maxWidth / width);
  const w = Math.round(width * scale), h = Math.round(height * scale);
  const pending = [];
  let discard = false;
  let failure = null;
  const dec = new VideoDecoder({
    output: (frame) => {
      if (discard || signal?.aborted) { frame.close(); return; }
      const ts=frame.timestamp/1e6;
      pending.push(createImageBitmap(frame, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
        .then(async (bitmap) => {
          if (discard || signal?.aborted) bitmap.close();
          else if (onFrame) { try { await onFrame({ ts, bitmap }); } catch(e) { bitmap.close(); throw e; } }
          else out.push({ ts, bitmap });
        }).catch(e=>{failure=e;})
        .finally(() => frame.close()));
    },
    error: (e) => { failure=e; },
  });
  try {
  // 슬라이드용 키프레임은 2초에 1장뿐이라 CPU로 충분하다. 강의 재생과 GPU 디코더를 다투지 않게 소프트웨어를 우선한다.
  const base = { codec: mp4.video.info.codec, codedWidth: width, codedHeight: height, description: mp4.video.description };
  const soft = { ...base, hardwareAcceleration: 'prefer-software' };
  const supported = await abortable(VideoDecoder.isConfigSupported(soft).then((r) => r.supported, () => false), signal);
  checkAbort(signal);
  dec.configure(supported ? soft : base);
  // 키프레임만 독립 디코딩한다. 각 키프레임 뒤에 flush해 출력을 확정한다.
  for (const k of keyframes) {
    dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: Math.round(k.ts * 1e6), data: k.data }));
    await abortable(dec.flush(), signal, () => { if (dec.state !== 'closed') dec.close(); });
    await abortable(Promise.all(pending.splice(0)), signal);
    checkAbort(signal);
    if(failure)throw failure;
  }
  await abortable(Promise.all(pending), signal);
  checkAbort(signal);
  if(failure)throw failure;
  return out.sort((a, b) => a.ts - b.ts);
  } catch(e) { discard = true;for(const f of out)f.bitmap.close();out.length = 0;throw e; }
  finally { if(dec.state!=='closed')dec.close(); }
}
