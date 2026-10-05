// 숫자 이중 확인. 같은 강의 음성도 앞뒤 문맥이 달라지면 Whisper가 숫자를 바꿔 받아쓴다
// (실측 2026-10-05: 단독 30초 클립 3회는 '출석의 10%', 앞에 무음이 붙은 이어 받아쓰기는 '20%').
// 숫자가 든 발화만 앞뒤 PAD초를 붙여 다시 받아쓰고, 원래 숫자가 다시 나오지 않으면 불일치로 남긴다.
// 텍스트 AI는 소리를 듣지 못하므로 이 결과를 근거로만 쓰고, 정답을 고르지는 않는다.
export const PAD = 3, MAX_PER_WINDOW = 3, MIN_GAP_MS = 3100;

export const numbersIn = (text) => (String(text ?? '').match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));

// 다시 받은 구간 중 원래 발화와 시간이 절반 이상 겹치는 것만 모은다(앞뒤 여유 구간의 다른 숫자 제외).
export function overlappingText(seg, recheck) {
  return recheck.filter((r) => {
    const overlap = Math.min(seg.end, r.end) - Math.max(seg.start, r.start);
    return overlap > 0 && overlap >= 0.5 * Math.min(seg.end - seg.start, r.end - r.start);
  }).map((r) => r.text.trim()).join(' ');
}

// 원래 숫자가 모두(개수까지) 다시 나오면 일치. 다시 받은 결과가 비었으면 판단하지 않는다(null).
export function numberMismatch(seg, recheck) {
  const alt = overlappingText(seg, recheck);
  if (!alt) return null;
  const pool = numbersIn(alt);
  for (const n of numbersIn(seg.text)) {
    const at = pool.indexOf(n);
    if (at < 0) return { alt };
    pool.splice(at, 1);
  }
  return null;
}
