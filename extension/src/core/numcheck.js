// 숫자 이중 확인. 같은 강의 음성도 앞뒤 문맥이 달라지면 Whisper가 숫자를 바꿔 받아쓴다
// (실측 2026-10-05: 단독 30초 클립 3회는 '출석의 10%', 앞에 무음이 붙은 이어 받아쓰기는 '20%').
// 숫자가 든 발화만 앞뒤 PAD초를 붙여 다시 받아쓰고, 원래 숫자가 다시 나오지 않으면 불일치로 남긴다.
// 텍스트 AI는 소리를 듣지 못하므로 이 결과를 근거로만 쓰고, 정답을 고르지는 않는다.
export const PAD = 3, MAX_PER_WINDOW = 3, MIN_GAP_MS = 3100;

// 쉼표는 구분자로 본다('6,8,9'와 '6, 8, 9'가 같아야 한다). '1,000'과 '1000'은 아래 이어 붙인 비교로 같게 본다.
export const numbersIn = (text) => String(text ?? '').match(/\d+(?:\.\d+)?/g) ?? [];

// 다시 받은 구간 중 원래 발화와 시간이 절반 이상 겹치는 것만 모은다(앞뒤 여유 구간의 다른 숫자 제외).
export function overlappingText(seg, recheck) {
  return recheck.filter((r) => {
    const overlap = Math.min(seg.end, r.end) - Math.max(seg.start, r.start);
    return overlap > 0 && overlap >= 0.5 * Math.min(seg.end - seg.start, r.end - r.start);
  }).map((r) => r.text.trim()).join(' ');
}

// 원래 숫자가 모두 다시 나오거나(횟수는 보지 않음) 숫자를 이어 붙인 값이 같으면 일치.
// 다시 받은 결과에 숫자가 하나도 없으면(빈 결과, '영' 같은 한글 숫자, 다른 말과 맞물림) 판단하지 않는다(null).
// 실측(2026-10-05, 55분 강의): 횟수·쉼표·한글 숫자까지 따지던 규칙은 표시 6건이 모두 표기 차이였다.
export function numberMismatch(seg, recheck) {
  const alt = overlappingText(seg, recheck), altNums = numbersIn(alt), nums = numbersIn(seg.text);
  if (!altNums.length || !nums.length) return null;
  if (nums.every((n) => altNums.includes(n)) || nums.join('') === altNums.join('')) return null;
  return { alt };
}
