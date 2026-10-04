// AI에 보낼 묶음을 토큰이 적게 들도록 만든다.
// - 원문 대본은 PC에만 두고 HTML에 그대로 쓴다(토큰 0). AI에는 군말을 덜어낸 대본만 보낸다.
// - AI는 원문을 다시 쓰지 않고, 슬라이드별 짧은 요약과 받아쓰기 교정 목록만 돌려준다(출력 토큰 최소화).
// - 이미지는 화면에 오래 나온 슬라이드부터 상한까지만, 여백을 잘라 축소해서 보낸다.

export const PRESETS = {
  save: { label: '절약', maxImages: 10, imageWidth: 896 },
  standard: { label: '표준', maxImages: 25, imageWidth: 1024 },
  detail: { label: '상세', maxImages: 60, imageWidth: 1024 }, // host 상한(80)보다 낮게 고정(레드팀 R5)
};

// 호출 1회당 고정으로 드는 입력 토큰(실측, 2026-10-04). claude는 최소 옵션 기준.
export const OVERHEAD = { claude: 1900, codex: 15300 };

const MIN_IMAGE_SEC = 8;

export const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const FILLER = /(^|\s)(음+|어+|아+|에+|예|네|자|그|뭐|이제|그죠\?*|그렇죠\?*|알겠죠\?*|맞죠\?*)[,.?]?(?=\s|$)/g;

export function compact(text) {
  return text
    .replace(FILLER, ' ')
    .replace(/(\S+)( \1)+/g, '$1') // 같은 단어 반복
    .replace(/\s+/g, ' ')
    .trim();
}

// 대본 문장을 슬라이드 구간에 배정한다(문장 중간 시각 기준).
export function groupBySlide(slides, segments) {
  const groups = slides.map((s) => ({ ...s, segs: [] }));
  let k = 0;
  for (const seg of segments) {
    const mid = (seg.start + seg.end) / 2;
    while (k < groups.length - 1 && mid >= groups[k].end) k++;
    groups[k]?.segs.push(seg);
  }
  return groups;
}

async function blobToB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const imageTokens = (w, h) => Math.ceil((w * h) / 750);

// toJpeg: slides.js의 toJpeg (bitmap 입력). 슬라이드 blob을 다시 인코딩할 때 쓴다.
export async function buildPack({ lecture, slides, segments, preset = 'standard', provider = 'claude', toJpeg }) {
  const P = PRESETS[preset] ?? PRESETS.standard;
  const groups = groupBySlide(slides, segments);
  const ranked = groups
    .map((g, i) => ({ i, d: g.end - g.start }))
    .filter((x) => x.d >= MIN_IMAGE_SEC)
    .sort((a, b) => b.d - a.d)
    .slice(0, P.maxImages);
  const withImage = new Set(ranked.map((x) => x.i));

  const images = [];
  let imgTok = 0;
  const lines = [`강의: ${lecture.title} (${mmss(lecture.duration)})`];
  for (const [i, g] of groups.entries()) {
    let tag = '이미지 없음';
    if (withImage.has(i)) {
      const bmp = await createImageBitmap(g.blob);
      let jpg;
      try { jpg = await toJpeg(bmp, { maxWidth: P.imageWidth, quality: 0.7, crop: true }); }
      finally { bmp.close(); }
      const small = await createImageBitmap(jpg);
      try { imgTok += imageTokens(small.width, small.height); }
      finally { small.close(); }
      images.push({ name: `s${i + 1}.jpg`, b64: await blobToB64(jpg) });
      tag = `이미지 ${images.length}번째`;
    }
    const text = compact(g.segs.map((s) => s.text).join(' '));
    lines.push(`\n[S${i + 1} ${mmss(g.start)}-${mmss(g.end)} | ${tag}]\n${text || '(발화 없음)'}`);
  }
  const prompt = lines.join('\n');
  const textTok = Math.ceil(prompt.length / 1.4) + Math.ceil(SYSTEM.length / 3);
  return {
    system: SYSTEM,
    prompt,
    images,
    slideCount: groups.length,
    estimate: { text: textTok, images: imgTok, overhead: OVERHEAD[provider] ?? 0, total: textTok + imgTok + (OVERHEAD[provider] ?? 0) },
  };
}

export const SYSTEM = `너는 대학 강의 요약가다. 입력은 슬라이드(S번호)별 교수 발화 받아쓰기와 일부 슬라이드 이미지다(이미지는 '이미지 N번째' 표시 순서대로 첨부).
받아쓰기는 음성인식이라 오인식이 있다. 슬라이드 내용으로 바로잡아 이해하라.
반드시 JSON 하나만 출력하라. 설명·코드펜스 금지. 형식:
{"overview":"강의 전체 핵심 3~5문장","slides":[{"s":1,"summary":["핵심 1~3개, 각 60자 이내"],"comment":"교수가 강조한 점이나 슬라이드에 없는 보충 설명 1문장, 없으면 빈 문자열"}],"corrections":[["오인식","바른 말"]],"exam":["시험에 나올 만한 포인트 3~7개"]}
- slides는 입력의 모든 S번호를 순서대로 포함. 발화가 없고 이미지도 없으면 summary는 [].
- corrections는 확실한 음성인식 오류만, 최대 40개. 같은 오류는 한 번만.
- 수식은 일반 텍스트로(예: O(n log n)).`;
