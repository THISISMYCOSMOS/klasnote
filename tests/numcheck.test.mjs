import test from 'node:test';
import assert from 'node:assert/strict';
import { numbersIn, numberMismatch } from '../extension/src/core/numcheck.js';
import { suspectReasons } from '../extension/src/core/suspect.js';
import { buildPack } from '../extension/src/core/pack.js';
import { buildReport } from '../extension/src/core/report.js';

const seg = (start, end, text) => ({ start, end, text });
// Measured on 2026-10-05: chained transcription said 20%, three standalone runs said 10%.
const chained = seg(85.9, 88.6, '이 해당되는 성적평가에는 출석의 20%,');

test('a number that does not come back in the padded re-transcription is a mismatch', () => {
  assert.deepEqual(numberMismatch(chained, [seg(84.6, 91.8, '이 해당되는 성적 평가에는 출석의 10%, 중간고사, 기말고사가 있을 거고요.')]),
    { alt: '이 해당되는 성적 평가에는 출석의 10%, 중간고사, 기말고사가 있을 거고요.' });
  assert.equal(numberMismatch(seg(85.9, 88.6, '출석의 10%,'), [seg(84.6, 91.8, '이 해당되는 성적 평가에는 출석의 10%, 중간고사')]), null);
});

test('numbers in the padding that belong to neighbouring speech are ignored', () => {
  const recheck = [seg(82.4, 85.8, '3학년에서 20명이'), seg(85.8, 88.7, '출석의 10%')];
  assert.deepEqual(numberMismatch(chained, recheck), { alt: '출석의 10%' });
  assert.equal(numberMismatch(seg(85.9, 88.6, '출석의 10%'), recheck), null);
});

test('an empty re-transcription is not judged; separators and repeat counts do not cause a mismatch', () => {
  assert.equal(numberMismatch(chained, []), null);
  assert.deepEqual(numbersIn('6,8,9와 3.5% 그리고 2학년'), ['6', '8', '9', '3.5', '2']);
  assert.equal(numberMismatch(seg(0, 4, '1,000명'), [seg(0, 4, '1000명')]), null);
  assert.equal(numberMismatch(seg(0, 4, '10번 10번 반복'), [seg(0, 4, '10번 반복')]), null, 'repeat counts are not compared');
});

test('a mismatch is flagged in the report and handed to the AI with both versions, original text untouched', async () => {
  const flagged = { ...chained, numberCheck: '출석의 10%' };
  assert.deepEqual(suspectReasons([flagged]), ['숫자 재확인 결과가 다름 (다시 받아쓴 결과: 출석의 10%)']);
  const pack = await buildPack({ lecture: { title: '숫자', duration: 90 }, slides: [{ start: 80, end: 87, blob: null }], segments: [flagged] });
  assert.match(pack.prompt, /#1 이 해당되는 성적평가에는 출석의 20%, \[숫자 재확인: 출석의 10%\]/);
  assert.match(pack.system, /\[숫자 재확인: …\]은 같은 음성을 앞뒤를 붙여 다시 받아쓴 결과/);
  const html = await buildReport({ lecture: { title: '숫자', duration: 90 }, groups: [{ start: 80, end: 90, segs: [flagged] }], summary: null, meta: {} });
  assert.match(html, /<span class="suspect" title="확인 필요: 숫자 재확인 결과가 다름 \(다시 받아쓴 결과: 출석의 10%\)">이 해당되는 성적평가에는 출석의 20%,<\/span>/);
});

test('real 55-minute lecture: formatting differences are not flagged, a real disagreement still is', () => {
  // Pairs from 3주차_DM_기초선형대수_1.html (2026-10-05); the first three were false flags under the old rule.
  assert.equal(numberMismatch(seg(0, 3, '이렇게 0땡 하면 이거 뭐죠?'), [seg(0, 3, '이렇게 영땡 하면 이거 뭐죠?')]), null);
  assert.equal(numberMismatch(seg(0, 3, '2x5짜리 행열입니다. 그렇죠?'), [seg(0, 3, '그렇죠. 그리고')]), null);
  assert.equal(numberMismatch(seg(0, 5, '이게 6, 2, 4, 7, 4, 1 이런 매트릭스라면'), [seg(0, 5, '이게 624741 이런 매출 기술을 하면')]), null);
  assert.equal(numberMismatch(seg(0, 5, '1바이 N자리와 N바이 1자리를 곱한다'), [seg(0, 5, '1 by n 자리와 n by 1 자리를 곱한다')]), null);
  assert.deepEqual(numberMismatch(seg(0, 4, '6, 8, 2, 6, 8, 9에 해당되는 개수를'), [seg(0, 4, '6, 8, 9에 해당되는 기술을')]), { alt: '6, 8, 9에 해당되는 기술을' });
});
