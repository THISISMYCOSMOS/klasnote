// 결과 HTML 한 파일을 만든다. 슬라이드 이미지는 파일 안에 넣어 혼자 열린다.
// 원문(교수님 발화)은 로컬 받아쓰기 그대로 두고, AI 교정 목록에 있는 말만 표시해 고친다.
import { mmss } from './pack.js';
import { suspectReasons } from './suspect.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 교정은 AI가 지목한 발화(#번호, pack.js와 같은 순번) 안에서만 적용한다. 강의 전체 치환은 같은 말이
// 맞게 쓰인 다른 문장까지 바꿨다. 발화 안에서 원문 표현이 정확히 한 번 나올 때만 적용하고, 겹치거나
// 존재하지 않는 슬라이드를 근거로 든 교정은 버린다. 원문(이스케이프 전)에 적용한 뒤 조각마다 이스케이프한다
// (태그 속성 안 재치환에 의한 HTML 주입 방지, 레드팀 R2).
function correctionsBySegment(corrections, slideCount) {
  const map = new Map();
  for (const c of corrections) {
    if (!c || !Number.isInteger(c.id) || typeof c.from !== 'string' || typeof c.to !== 'string') continue;
    if (!c.from.trim() || c.from.length > 40 || !c.to.trim() || c.to.length > 80 || c.from === c.to) continue;
    if (c.s !== undefined && !(Number.isInteger(c.s) && c.s >= 1 && c.s <= slideCount)) continue;
    if (!map.has(c.id)) map.set(c.id, []);
    map.get(c.id).push(c);
  }
  return map;
}

const suspectSpan = (html, reason) => reason ? `<span class="suspect" title="${esc(`확인 필요: ${reason}`)}">${html}</span>` : html;

function renderSegment(text, list = []) {
  const hits = [];
  for (const c of list) {
    const at = text.indexOf(c.from);
    if (at < 0 || text.indexOf(c.from, at + 1) >= 0) continue;
    const end = at + c.from.length;
    if (hits.some((h) => at < h.end && end > h.at)) continue;
    hits.push({ at, end, c });
  }
  hits.sort((a, b) => a.at - b.at);
  let out = '', last = 0;
  for (const { at, end, c } of hits) {
    const why = `받아쓰기 원래: ${c.from}${c.s ? ` · 근거 S${c.s}` : ''}`;
    out += esc(text.slice(last, at)) + `<mark title="${esc(why)}">${esc(c.to)}</mark>`;
    last = end;
  }
  return out + esc(text.slice(last));
}

const VIEW_SCRIPT = "document.querySelectorAll('.view button').forEach(b=>b.onclick=()=>{document.body.dataset.view=b.dataset.v;document.querySelectorAll('.view button').forEach(x=>x.setAttribute('aria-pressed',x===b))});";

async function sha256b64(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return btoa(String.fromCharCode(...d));
}

// 음성인식 조각(2~5초)을 읽기 좋은 문단으로 묶는다. 말이 1.5초 이상 끊기거나 문단이 길어지면 나눈다.
// 시각은 문단 시작에만 붙인다. 원문 단어는 바꾸지 않는다.
export function toParagraphs(segs, { gap = 1.5, maxChars = 220 } = {}) {
  const paras = [];
  let cur = null;
  for (const s of segs) {
    const text = s.text.trim();
    if (!text) continue;
    const breakHere = !cur || s.start - cur.end > gap || (cur.text.length > maxChars && /[.?!요죠다]$/.test(cur.text));
    if (breakHere) { cur = { start: s.start, end: s.end, text, segs: [s] }; paras.push(cur); }
    else { cur.text += ' ' + text; cur.end = s.end; cur.segs.push(s); }
  }
  return paras;
}

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(s)}`;
}

// groups: groupBySlide 결과 [{start,end,blob,segs}], summary: AI JSON 또는 null
export async function buildReport({ lecture, groups, summary, meta }) {
  const noteUrl = /^[a-p]{32}$/.test(meta.extensionId ?? '') && /^[0-9a-f]{8,32}$/i.test(lecture.contentId ?? '')
    ? `chrome-extension://${meta.extensionId}/note-launch.html?id=${lecture.contentId.toLowerCase()}` : null;
  const corrections = correctionsBySegment((summary?.corrections ?? []).slice(0, 60), groups.length);
  const scriptHash = await sha256b64(VIEW_SCRIPT);
  const cards = [];
  // 의심 구간 판정은 앞뒤 발화를 봐야 하므로 슬라이드 순서대로 이은 전체 발화에 대해 한 번 계산한다.
  const suspects = suspectReasons(groups.flatMap((g) => g.segs));
  let n = 0;
  for (const [i, g] of groups.entries()) {
    const img = g.blob ? `<img loading="lazy" src="${await blobToDataUrl(g.blob)}" alt="슬라이드 ${i + 1}">` : '';
    const segs = g.segs.map((s) => ({ ...s, n: ++n }));
    const verbatim = toParagraphs(segs).map((x) => `<p><time>${mmss(x.start)}</time> ${x.segs.map((s) => suspectSpan(renderSegment(s.text.trim(), corrections.get(s.n)), suspects[s.n - 1])).join(' ')}</p>`).join('');
    cards.push(`<section class="card" id="s${i + 1}">
<header><b>S${i + 1}</b> <time>${mmss(g.start)} – ${mmss(g.end)}</time></header>
<div class="body"><div class="img">${img}</div><div class="text">
<div class="raw"><h4>교수님 원문</h4>${verbatim || '<p class="muted">(발화 없음)</p>'}</div>
</div></div></section>`);
  }
  const exam = (summary?.exam ?? []).map((t) => `<li>${esc(t)}</li>`).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'">
<title>${esc(lecture.title)} – 강의 정리</title>
<style>
:root{--bg:#fff;--fg:#1b1b1f;--muted:#6b6b76;--line:#e3e3e8;--card:#fafafb;--accent:#8b1d3f;--mark:#fff1a8}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#ececf1;--muted:#9a9aa6;--line:#2c2c33;--card:#1c1c21;--accent:#e07a9a;--mark:#5a4b00}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 system-ui,-apple-system,"Malgun Gothic",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.meta{color:var(--muted);font-size:13px}.kicker{margin:0 0 2px;color:var(--accent);font-weight:600;font-size:14px}
.info{display:flex;flex-wrap:wrap;gap:4px 20px;margin:8px 0 0;font-size:13px}.info div{display:flex;gap:6px}.info dt{color:var(--muted)}.info dd{margin:0}.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px}
.view{position:sticky;top:0;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line);z-index:1;display:flex;gap:6px}
.view button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:5px 12px;cursor:pointer;font:inherit;font-size:13px}
.view button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
.note-action{display:inline-block;margin-top:12px;padding:8px 16px;background:var(--accent);color:#fff;border-radius:8px;text-decoration:none;font-weight:600}.note-help{margin:4px 0 12px;color:var(--muted);font-size:12px}
.card{border:1px solid var(--line);border-radius:10px;margin:14px 0;overflow:hidden;break-inside:avoid}
.card header{padding:8px 14px;background:var(--card);border-bottom:1px solid var(--line);font-size:13px}.card header time{color:var(--muted);margin-left:6px}
.body{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:16px;padding:14px}
.img img{width:100%;border-radius:6px;border:1px solid var(--line)}
.overview,.lecture-summary li{white-space:pre-line}.muted{color:var(--muted)}
.raw h4{margin:12px 0 4px;font-size:13px;color:var(--muted)}.raw p{margin:0 0 8px;font-size:14px}.raw time{display:inline-block;margin-right:6px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
mark{background:var(--mark);color:inherit;border-radius:3px;padding:0 2px}
.suspect{color:var(--muted);text-decoration:underline wavy;text-decoration-color:var(--accent);cursor:help}
body[data-view=sum] .card{display:none}body[data-view=raw] .lecture-summary{display:none}body[data-view=raw] .raw h4{margin-top:0}
@media (max-width:760px){.body{grid-template-columns:1fr}}
@media print{.view{display:none}.card{page-break-inside:avoid}}
</style></head><body data-view="both"><main>
<p class="kicker">${esc([lecture.course, lecture.professor && `${lecture.professor} 교수`].filter(Boolean).join(' · '))}</p>
<h1>${lecture.week ? `${esc(lecture.week)}주차 · ` : ''}${esc(lecture.title)}</h1>
<dl class="info">
${lecture.module ? `<div><dt>단원</dt><dd>${esc(lecture.module)}</dd></div>` : ''}
${lecture.period ? `<div><dt>학습기간</dt><dd>${esc(lecture.period)}</dd></div>` : ''}
<div><dt>강의 길이</dt><dd>${mmss(lecture.duration)} · 슬라이드 ${groups.length}장</dd></div>
<div><dt>정리</dt><dd>받아쓰기 ${esc(meta.asrModel)} · 요약 ${esc(meta.aiLabel)} · ${esc(meta.createdAt)}</dd></div>
</dl>
${summary ? `<section class="lecture-summary"><h2>강의 전체 핵심</h2><div class="box"><p class="overview">${esc(summary.overview)}</p></div>${exam ? `<h2>시험 포인트</h2><div class="box"><ul>${exam}</ul></div>` : ''}</section>` : '<div class="box"><p>AI 요약 없이 원문만 정리한 파일입니다.</p></div>'}
${noteUrl ? `<a class="note-action" href="${esc(noteUrl)}" target="_blank" rel="noopener noreferrer">요약노트 만들기</a><p class="note-help">KLAS 강의 요약 확장이 설치된 Chrome에서 열면, 저장된 받아쓰기로 요약을 준비합니다. 확인 후에만 AI로 전송합니다.</p>` : ''}
<div class="view" role="group" aria-label="보기 방식"><button data-v="both" aria-pressed="true">함께 보기</button><button data-v="sum" aria-pressed="false">요약만</button><button data-v="raw" aria-pressed="false">원문만</button></div>
${cards.join('\n')}
<p class="meta">원문은 이 PC에서 음성인식으로 받아쓴 것이라 오류가 있을 수 있습니다. <span class="suspect">물결 밑줄</span>은 음성인식이 지어냈을 수 있어 확인이 필요한 부분입니다. <mark>표시</mark>는 AI가 교정한 말이며, 마우스를 올리면 원래 받아쓰기가 보입니다. 개인 학습용이며, 강의 자료의 저작권은 교수자에게 있습니다.</p>
</main><script>${VIEW_SCRIPT}</script></body></html>`;
}
