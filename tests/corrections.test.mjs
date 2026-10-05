import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../extension/src/core/report.js';
import { buildPack } from '../extension/src/core/pack.js';
import { parseSummary } from '../extension/src/core/policy.js';

const seg = (start, text) => ({ start, end: start + 2, text });
const report = (segs, corrections, slides = 1) => buildReport({
  lecture: { title: '교정', duration: 60 },
  groups: Array.from({ length: slides }, (_, i) => ({ start: i * 30, end: i * 30 + 30, segs: i ? [] : segs })),
  summary: { overview: '', exam: [], slides: [], corrections }, meta: {},
});
const marks = (html) => [...html.matchAll(/<mark title="([^"]*)">([^<]*)<\/mark>/g)].map((m) => [m[1], m[2]]);

test('a correction changes only the named utterance, not the same word elsewhere', async () => {
  // Reproduces the old whole-lecture replacement that also rewrote the correct sentence.
  const html = await report([seg(0, '연결 리스트의 노트를 삭제합니다'), seg(10, '노트에 필기하세요')], [{ id: 1, from: '노트', to: '노드', s: 1 }]);
  assert.deepEqual(marks(html), [['받아쓰기 원래: 노트 · 근거 S1', '노드']]);
  assert.match(html, /노트에 필기하세요/);
});

test('ambiguous, missing, overlapping and unsupported-evidence corrections are skipped', async () => {
  const html = await report([seg(0, '교환 교환을 봅니다'), seg(5, '묵자를 보세요'), seg(9, '데이터 마닝 수업')], [
    { id: 1, from: '교환', to: '교안' },
    { id: 2, from: '목차', to: '차례' },
    { id: 2, from: '묵자', to: '목차', s: 9 },
    { id: 3, from: '데이터 마닝', to: '데이터 마이닝' },
    { id: 3, from: '마닝 수업', to: '마이닝 수업' },
    { id: 7, from: '수업', to: '강의' },
  ]);
  assert.deepEqual(marks(html), [['받아쓰기 원래: 데이터 마닝', '데이터 마이닝']]);
});

test('correction text is escaped inside and around the mark', async () => {
  const html = await report([seg(0, 'a<b 비교')], [{ id: 1, from: 'a<b', to: '"x"><script>' }]);
  assert.doesNotMatch(html, /<script>alert|"x"><script>/);
  assert.match(html, /<mark title="받아쓰기 원래: a&lt;b">&quot;x&quot;&gt;&lt;script&gt;<\/mark> 비교/);
});

test('summary parser keeps per-utterance corrections and drops the old global pair format', () => {
  const base = { overview: '', slides: [], exam: [] };
  const parsed = parseSummary(JSON.stringify({ ...base, corrections: [
    ['노트', '노드'], { id: '4', from: '교환', to: '교안', s: '2' }, { id: 5, from: '묵자', to: '목차', s: null },
    { id: 0, from: 'a', to: 'b' }, { id: 6, from: 'x'.repeat(41), to: 'y' }, { id: 7, from: '같음', to: '같음' }, { id: 8, from: 'a', to: 'b', s: 1.5 },
  ] }));
  assert.deepEqual(parsed.corrections, [{ id: 4, from: '교환', to: '교안', s: 2 }, { id: 5, from: '묵자', to: '목차' }]);
  // A real 55-minute lecture used all 40 slots, so the cap is 80.
  const many = parseSummary(JSON.stringify({ ...base, corrections: Array.from({ length: 90 }, (_, i) => ({ id: i + 1, from: 'a', to: 'b' })) }));
  assert.equal(many.corrections.length, 80);
});

test('AI input numbers utterances the same way the report does, skipping empty lines', async () => {
  const lecture = { title: '번호', duration: 20 };
  const slides = [{ start: 0, end: 5, blob: null }, { start: 5, end: 12, blob: null }]; // under 8 s: no image encoding
  const segments = [seg(0, '첫 발화'), seg(2.5, ' '), seg(6, '세 번째 교환')];
  const pack = await buildPack({ lecture, slides, segments });
  assert.match(pack.prompt, /\[S1 [^\n]*\]\n#1 첫 발화\n\n\[S2 [^\n]*\]\n#3 세 번째 교환/);
  assert.doesNotMatch(pack.prompt, /#2/);
  const html = await buildReport({ lecture, groups: [{ start: 0, end: 5, segs: segments.slice(0, 2) }, { start: 5, end: 20, segs: segments.slice(2) }],
    summary: { overview: '', exam: [], slides: [], corrections: [{ id: 3, from: '교환', to: '교안', s: 2 }] }, meta: {} });
  assert.deepEqual(marks(html), [['받아쓰기 원래: 교환 · 근거 S2', '교안']]);
});

test('the AI sees each utterance verbatim, so a quoted span around fillers is found and fully corrected', async () => {
  // Independent review: compacted input made these corrections disappear or apply to half of a repeated word.
  const lecture = { title: '원문', duration: 6 }, segments = [seg(0, '어 노드를 음 연결합니다'), seg(3, '이제 이제 노드 노드 그래프')];
  const pack = await buildPack({ lecture, slides: [{ start: 0, end: 6, blob: null }], segments });
  assert.match(pack.prompt, /#1 어 노드를 음 연결합니다\n#2 이제 이제 노드 노드 그래프/);
  const html = await buildReport({ lecture, groups: [{ start: 0, end: 6, segs: segments }],
    summary: { overview: '', exam: [], slides: [], corrections: [{ id: 1, from: '노드를 음 연결', to: '노트를 연결' }, { id: 2, from: '노드 노드 그래프', to: '노드 그래프' }] }, meta: {} });
  assert.deepEqual(marks(html).map((m) => m[1]), ['노트를 연결', '노드 그래프']);
});

test('an audio-only lecture builds an AI pack without trying to encode a missing slide image', async () => {
  // Independent review: the synthetic slide for lectures without slides has no blob and crashed buildPack at 8 s or longer.
  const pack = await buildPack({ lecture: { title: '음성만', duration: 600 }, slides: [], segments: [seg(0, '첫 발화'), seg(590, '마지막 발화')] });
  assert.equal(pack.images.length, 0);
  assert.match(pack.prompt, /\| 이미지 없음\]\n#1 첫 발화\n#2 마지막 발화/);
});
