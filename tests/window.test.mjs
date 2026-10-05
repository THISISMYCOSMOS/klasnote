import test from 'node:test';
import assert from 'node:assert/strict';
import { WINDOW, TAIL, BACKTRACK, commitWindow } from '../extension/src/core/window.js';

const seg = (start, end, text = 'x') => ({ start, end, text });
const t = 100, aEnd = t + WINDOW + TAIL, horizon = t + WINDOW;

test('segments starting in the tail are discarded, including a short end-of-audio hallucination', () => {
  // Measured with whisper-large-v3: a 0.14 s segment at the very end repeated an earlier sentence.
  const { segs, next } = commitWindow([seg(100, 105), seg(150, 156), seg(aEnd - 0.16, aEnd - 0.02, 'repeated sentence')], { t, aEnd, final: false });
  assert.deepEqual(segs.map(s => s.start), [100, 150]);
  assert.equal(next, horizon - BACKTRACK);
});

test('a sentence crossing the commit boundary is kept whole and the next window starts after it', () => {
  const { segs, next } = commitWindow([seg(100, 108), seg(horizon - 2, horizon + 4)], { t, aEnd, final: false });
  assert.deepEqual(segs.map(s => s.start), [100, horizon - 2]);
  assert.equal(next, horizon + 4);
});

test('a segment running into the end of the sent audio is re-transcribed by the next window', () => {
  const { segs, next } = commitWindow([seg(100, 108), seg(horizon - 3, aEnd - 0.1)], { t, aEnd, final: false });
  assert.deepEqual(segs.map(s => s.start), [100]);
  assert.equal(next, horizon - 3);
});

test('silence before the boundary advances with a one-second backtrack', () => {
  assert.deepEqual(commitWindow([], { t, aEnd, final: false }), { segs: [], next: horizon - BACKTRACK });
});

test('the final window keeps every segment and finishes at the lecture end', () => {
  const all = [seg(100, 105), seg(150, 160)];
  assert.deepEqual(commitWindow(all, { t, aEnd: 160, final: true }), { segs: all, next: 160 });
});

test('shrunken windows still advance and never re-store a committed segment', () => {
  for (const span of [60, 30, 15, 7.5, 3.75]) {
    const end = t + span;
    const { segs, next } = commitWindow([seg(t, t + span * 0.4), seg(t + span * 0.6, end - 0.1)], { t, aEnd: end, final: false });
    assert.ok(next > t, `span ${span} advances`);
    assert.ok(segs.every(s => s.start < next), `span ${span} keeps only segments before the next start`);
  }
});
