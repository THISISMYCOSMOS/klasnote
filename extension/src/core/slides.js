// 키프레임에서 화면이 바뀐 지점만 남겨 슬라이드로 만든다.
// 작은 흑백 썸네일의 평균 절대 차이로 판단한다. 판서나 커서 이동 같은 작은 변화는 같은 슬라이드로 본다.

const TW = 64, TH = 36;

function thumb(bitmap) {
  const c = new OffscreenCanvas(TW, TH);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, TW, TH);
  const d = g.getImageData(0, 0, TW, TH).data;
  const gray = new Float32Array(TW * TH);
  for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
  return gray;
}

function diff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// 구간을 나눠 처리해도 이어지도록 상태를 가진 감지기.
// push(frames)는 확정된 슬라이드(다음 슬라이드가 시작되어 끝이 정해진 것)를 반환한다.
export function createSlideDetector({ threshold = 0.04, minDuration = 4 } = {}) {
  let cur = null, curT = null;
  return {
    dispose() { cur?.bitmap.close(); cur = null; curT = null; },
    push(frames) {
      const done = [];
      for (const f of frames) {
        const t = thumb(f.bitmap);
        // 같은 슬라이드면 판서가 누적된 마지막 프레임을, 너무 짧게 지나간 화면(전환 애니메이션 등)이면
        // 새 화면을 대표로 쓴다. 밀려난 프레임은 바로 해제해 메모리를 아낀다.
        if (cur && (diff(t, curT) <= threshold || f.ts - cur.start < minDuration)) {
          cur.bitmap.close();
          cur.bitmap = f.bitmap;
          curT = t;
          continue;
        }
        if (cur) { cur.end = f.ts; done.push(cur); }
        cur = { start: f.ts, end: null, bitmap: f.bitmap };
        curT = t;
      }
      return done;
    },
    finish(until) {
      if (!cur) return [];
      cur.end = until;
      const last = cur;
      cur = null;
      return [last];
    },
  };
}

// 슬라이드 가장자리의 단색 여백을 찾아 내용 영역만 남긴다(토큰 절약).
function contentBox(bitmap) {
  const w = 320, h = Math.round(bitmap.height * 320 / bitmap.width);
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const px = (x, y) => { const i = (y * w + x) * 4; return d[i] + d[i + 1] + d[i + 2]; };
  const bg = px(2, 2);
  const busyCol = (x) => { let n = 0; for (let y = 0; y < h; y += 2) if (Math.abs(px(x, y) - bg) > 60) n++; return n > 2; };
  const busyRow = (y) => { let n = 0; for (let x = 0; x < w; x += 2) if (Math.abs(px(x, y) - bg) > 60) n++; return n > 2; };
  let l = 0, r = w - 1, t = 0, b = h - 1;
  while (l < r && !busyCol(l)) l++;
  while (r > l && !busyCol(r)) r--;
  while (t < b && !busyRow(t)) t++;
  while (b > t && !busyRow(b)) b--;
  const k = bitmap.width / w, pad = 6;
  const box = { x: Math.max(0, (l - pad) * k), y: Math.max(0, (t - pad) * k) };
  box.w = Math.min(bitmap.width - box.x, (r - l + 2 * pad) * k);
  box.h = Math.min(bitmap.height - box.y, (b - t + 2 * pad) * k);
  // 거의 다 잘려 나가면(전체가 단색 등) 원본을 쓴다.
  if (box.w < bitmap.width * 0.3 || box.h < bitmap.height * 0.3) return { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  return box;
}

export async function toJpeg(bitmap, { maxWidth = 1280, quality = 0.85, crop = false } = {}) {
  const box = crop ? contentBox(bitmap) : { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  const s = Math.min(1, maxWidth / box.w);
  const c = new OffscreenCanvas(Math.round(box.w * s), Math.round(box.h * s));
  c.getContext('2d').drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: 'image/jpeg', quality });
}
