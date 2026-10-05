// 받아쓰기 구간 경계 처리. 구간을 고정 시각에서 자르면 말 중간이 잘려 단어가 빠지거나
// 끝에 없는 문장이 생긴다(실측: large-v3가 30초 클립 끝 0.14초에 앞 문장을 다시 생성).
// 그래서 확정 범위보다 TAIL초 더 보내고, 확정 범위 안에서 시작한 구간만 저장한 뒤
// 다음 구간은 마지막으로 저장한 발화가 끝난 지점부터 시작한다. 같은 말을 두 번 저장하지 않는다.
export const WINDOW = 110, TAIL = 10, BACKTRACK = 1, CUT_GUARD = 0.5;

// segs: 절대 시각 구간 [{start,end,text}], t: 보낸 오디오 시작, aEnd: 보낸 오디오 끝, final: 강의 끝까지 보냈는지
// 반환 next: 다음 오디오 시작이자 저장 지점. 항상 t보다 크다.
export function commitWindow(segs, { t, aEnd, final }) {
  if (final) return { segs, next: aEnd };
  const span = aEnd - t, horizon = aEnd - Math.min(TAIL, span / 4);
  const kept = segs.filter((s) => s.start < horizon);
  const last = kept.at(-1);
  // 확정 범위 끝에서 시작해 보낸 오디오 끝까지 이어진 발화는 잘렸을 수 있다. 다음 구간에서 다시 받는다.
  if (last && last.end >= aEnd - CUT_GUARD && last.start >= t + span / 2) {
    kept.pop();
    return { segs: kept, next: last.start };
  }
  // 확정 범위 안에 발화가 시작하지 않은 마지막 부분은 무음으로 보고 BACKTRACK초만 남겨 다시 보낸다.
  // 시각 반올림으로 범위 직후에 시작한 말의 첫 음절이 잘리지 않게 하기 위함이다.
  return { segs: kept, next: Math.max(last?.end ?? t, horizon - BACKTRACK) };
}
