// kwcommons 강의 mp4에서 필요한 구간의 오디오(PCM 16kHz)와 키프레임(슬라이드 후보)을 뽑는다.
// 전제(실측): progressive mp4, moov가 앞쪽(faststart), H.264 + AAC, 키프레임 약 1초 간격.
// 전역 MP4Box(vendor/mp4box.all.js)가 먼저 로드되어 있어야 한다.

const KW = 'https://kwcommons.kw.ac.kr';

// fetchImpl(url, init)을 주입받는다. 확장에서는 fetch, 개발 서버에서는 프록시 fetch.
export function createSource(fetchImpl = fetch) {
  async function getText(url) {
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return r.text();
  }
  async function getRange(url, start, endInclusive) {
    const r = await fetchImpl(url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
    if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status} range ${url}`);
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
  const mediaFile = q('main_media');
  const uriTpl = [...doc.querySelectorAll('service_root media_uri')]
    .find((n) => n.getAttribute('method') === 'progressive')?.textContent?.trim();
  if (!mediaFile || !uriTpl) throw new Error('지원하지 않는 콘텐츠 형식입니다 (progressive mp4 없음).');
  return { contentId, title, duration, mediaUrl: uriTpl.replace('[MEDIA_FILE]', mediaFile) };
}

// mp4 앞부분(ftyp+moov)만 받아 트랙과 샘플 표를 만든다.
export async function openMp4(src, mediaUrl) {
  const head = await src.getRange(mediaUrl, 0, 65535);
  let off = 0, moovEnd = 0;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  while (off + 8 <= head.length) {
    const size = dv.getUint32(off);
    const type = String.fromCharCode(...head.subarray(off + 4, off + 8));
    if (type === 'moov') { moovEnd = off + size; break; }
    if (size < 8) break;
    off += size;
  }
  if (!moovEnd) throw new Error('moov가 파일 앞쪽에 없습니다 (faststart 아님).');
  const moov = moovEnd <= head.length ? head.subarray(0, moovEnd) : await src.getRange(mediaUrl, 0, moovEnd - 1);

  const file = MP4Box.createFile(false);
  const info = await new Promise((resolve, reject) => {
    file.onReady = resolve;
    file.onError = reject;
    const ab = moov.buffer.slice(moov.byteOffset, moov.byteOffset + moov.byteLength);
    ab.fileStart = 0;
    file.appendBuffer(ab);
    file.flush();
  });
  const vInfo = info.tracks.find((t) => t.video);
  const aInfo = info.tracks.find((t) => t.audio);
  if (!vInfo || !aInfo) throw new Error('오디오 또는 비디오 트랙이 없습니다.');
  const vTrak = file.getTrackById(vInfo.id);
  const aTrak = file.getTrackById(aInfo.id);
  return {
    mediaUrl,
    duration: info.duration / info.timescale,
    video: { info: vInfo, samples: vTrak.samples, description: codecDescription(vTrak) },
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
export async function fetchWindow(src, mp4, t0, t1, { slideEvery = 2 } = {}) {
  const aS = mp4.audio.samples.filter((s) => { const t = sec(s, mp4.audio); return t >= t0 && t < t1; });
  const vS = [];
  let next = t0;
  for (const s of mp4.video.samples) {
    if (!s.is_sync) continue;
    const t = sec(s, mp4.video);
    if (t < t0 || t >= t1) continue;
    if (t >= next) { vS.push(s); next = t + slideEvery; }
  }
  const all = aS.concat(vS);
  if (!all.length) return { audio: [], keyframes: [], bytes: 0 };
  const start = Math.min(...all.map((s) => s.offset));
  const end = Math.max(...all.map((s) => s.offset + s.size));
  const buf = await src.getRange(mp4.mediaUrl, start, end - 1);
  const cut = (s) => buf.subarray(s.offset - start, s.offset - start + s.size);
  return {
    audio: aS.map((s) => ({ ts: sec(s, mp4.audio), dur: s.duration / mp4.audio.info.timescale, data: cut(s) })),
    keyframes: vS.map((s) => ({ ts: sec(s, mp4.video), data: cut(s) })),
    bytes: buf.length,
  };
}

// AAC 샘플 → 16kHz 모노 Float32Array
export async function decodeAudio16k(mp4, samples) {
  if (!samples.length) return new Float32Array(0);
  const { sample_rate: rate, channel_count: ch } = mp4.audio.info.audio;
  const parts = [];
  let failure = null;
  const dec = new AudioDecoder({
    output: (ad) => {
      try {
      const n = ad.numberOfFrames, c = ad.numberOfChannels;
      const mono = new Float32Array(n);
      const tmp = new Float32Array(n);
      for (let i = 0; i < c; i++) {
        ad.copyTo(tmp, { planeIndex: i, format: 'f32-planar' });
        for (let j = 0; j < n; j++) mono[j] += tmp[j] / c;
      }
      parts.push(mono);
      } catch(e) { failure=e; } finally { ad.close(); }
    },
    error: (e) => { failure=e; },
  });
  try {
  dec.configure({ codec: mp4.audio.info.codec, sampleRate: rate, numberOfChannels: ch, description: mp4.audio.description });
  for (const s of samples) {
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s.ts * 1e6), duration: Math.round(s.dur * 1e6), data: s.data }));
  }
  await dec.flush();
  if(failure)throw failure;
  } finally { if(dec.state!=='closed')dec.close(); }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const pcm = new Float32Array(total);
  let o = 0;
  for (const p of parts) { pcm.set(p, o); o += p.length; }
  return resample(pcm, rate, 16000);
}

async function resample(pcm, from, to) {
  if (!pcm.length) return pcm;
  const ctx = new OfflineAudioContext(1, Math.ceil(pcm.length * to / from), to);
  const ab = ctx.createBuffer(1, pcm.length, from);
  ab.copyToChannel(pcm, 0);
  const node = ctx.createBufferSource();
  node.buffer = ab;
  node.connect(ctx.destination);
  node.start();
  return (await ctx.startRendering()).getChannelData(0);
}

// 키프레임 → { ts, bitmap } (가로 maxWidth로 축소)
export async function decodeKeyframes(mp4, keyframes, { maxWidth = 1280 } = {}) {
  const out = [];
  const { width, height } = mp4.video.info.video;
  const scale = Math.min(1, maxWidth / width);
  const w = Math.round(width * scale), h = Math.round(height * scale);
  const pending = [];
  let failure = null;
  const dec = new VideoDecoder({
    output: (frame) => {
      const ts=frame.timestamp/1e6;
      pending.push(createImageBitmap(frame, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
        .then((bitmap) => out.push({ ts, bitmap }),e=>{failure=e;})
        .finally(() => frame.close()));
    },
    error: (e) => { failure=e; },
  });
  try {
  dec.configure({ codec: mp4.video.info.codec, codedWidth: width, codedHeight: height, description: mp4.video.description });
  // 키프레임만 독립 디코딩한다. 각 키프레임 뒤에 flush해 출력을 확정한다.
  for (const k of keyframes) {
    dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: Math.round(k.ts * 1e6), data: k.data }));
    await dec.flush();
  }
  await Promise.all(pending);
  if(failure)throw failure;
  return out.sort((a, b) => a.ts - b.ts);
  } catch(e) { await Promise.all(pending);for(const f of out)f.bitmap.close();throw e; }
  finally { if(dec.state!=='closed')dec.close(); }
}
