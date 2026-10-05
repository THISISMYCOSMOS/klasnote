// Whisper가 지어냈을 가능성이 큰 받아쓰기 구간을 찾는다. 지우지 않고 HTML에 '확인 필요'로만 표시한다.
// Groq turbo의 no_speech_prob는 무음에서 지어낸 '감사합니다.'에도 0.000이라(실측) 쓰지 않고 글자·시각만 본다.
// 실측 근거(2026-10-05, 실제 강의 Groq 114구간): 정상 발화 초당 2.9–11자, 끝에서 지어낸 문장 초당 128.6자.
// 무음 10초에서 turbo·large-v3 모두 '감사합니다.', 이어 붙인 오디오의 무음에서 '자막제공자'를 생성했다.
const MAX_CHARS_PER_SEC = 20;
const SILENCE_PHRASES = [/^(시청해\s*주셔서\s*)?감사합니다[.!]?$/, /^자막\s*제공/, /구독(과|이나)?\s*좋아요/, /^MBC\s*뉴스/];
const REPEATED = /(\S.{1,30}?)(?:\s*\1){3,}/;

// segs: 시간 순서의 발화. 같은 길이의 배열로 이유 문자열 또는 null을 돌려준다.
export function suspectReasons(segs) {
  let prev = null, run = 0;
  return segs.map((s) => {
    const text = String(s.text ?? '').trim(), chars = text.replace(/\s/g, '').length, dur = s.end - s.start;
    const norm = text.replace(/[\s.,!?]/g, '');
    run = norm && norm === prev ? run + 1 : 1;
    prev = norm;
    // 숫자 이중 확인(numcheck.js)에서 원래 숫자가 다시 나오지 않은 발화. 어느 쪽이 맞는지는 판단하지 않는다.
    if (s.numberCheck) return `숫자 재확인 결과가 다름 (다시 받아쓴 결과: ${String(s.numberCheck).slice(0, 80)})`;
    if (chars && !(dur > 0 && chars / dur <= MAX_CHARS_PER_SEC)) return '말한 시간에 비해 글자가 너무 많음';
    if (SILENCE_PHRASES.some((re) => re.test(text))) return '무음에서 자주 생기는 문구';
    if (REPEATED.test(text) || run >= 3) return '같은 말 반복';
    return null;
  });
}
