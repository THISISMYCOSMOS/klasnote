import test from 'node:test';
import assert from 'node:assert/strict';
import { suspectReasons } from '../extension/src/core/suspect.js';
import { buildReport } from '../extension/src/core/report.js';

const seg = (start, end, text) => ({ start, end, text });

test('real Groq hallucinations are flagged while real fast speech is not', () => {
  // Texts and timings are taken from the 2026-10-05 Groq runs on a real lecture.
  const reasons = suspectReasons([
    seg(29.84, 29.98, '데이터 마이닝 수업을 맡은 이상민입니다.'),
    seg(0, 2, '감사합니다.'),
    seg(61.2, 63, '자막제공자'),
    seg(10, 12.18, 'Probabilistic Perspective 라고 써있죠.'),
    seg(13.4, 15, '전체 내용은 다음과 같습니다.'),
    seg(59.9, 73.5, '자체적인 기준으로 해서 성적을 비교하기보다는'),
    seg(100, 100.1, '그렇죠.'),
  ]);
  assert.deepEqual(reasons, ['말한 시간에 비해 글자가 너무 많음', '무음에서 자주 생기는 문구', '무음에서 자주 생기는 문구', null, null, null, null]);
});

test('a closing thanks inside a real sentence is not flagged', () => {
  assert.deepEqual(suspectReasons([seg(0, 4, '오늘 수업은 여기까지입니다. 감사합니다.')]), [null]);
});

test('generation loops are flagged within one segment and across consecutive identical segments', () => {
  assert.deepEqual(suspectReasons([seg(0, 10, '여러분 안녕하세요 안녕하세요 안녕하세요 안녕하세요 안녕하세요')]), ['같은 말 반복']);
  assert.deepEqual(suspectReasons([seg(0, 1, '네.'), seg(1, 2, '네.'), seg(2, 3, '데이터를 봅니다'), seg(3, 4, '데이터를 봅니다'), seg(4, 5, '데이터를 봅니다.')]),
    [null, null, null, null, '같은 말 반복']);
});

test('the report keeps flagged speech visible with an explanation instead of deleting it', async () => {
  const html = await buildReport({ lecture: { title: '표시', duration: 30 }, groups: [{ start: 0, end: 30, segs: [seg(0, 3, '정상 발화입니다'), seg(20, 22, '감사합니다.')] }],
    summary: null, meta: {} });
  assert.match(html, /정상 발화입니다/);
  assert.match(html, /<span class="suspect" title="확인 필요: 무음에서 자주 생기는 문구">감사합니다\.<\/span>/);
  assert.doesNotMatch(html, /<span class="suspect"[^>]*>정상/);
});
