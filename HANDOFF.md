# HANDOFF — klasnote (klas-summarizer)

갱신: 2026-10-05, 브랜치 `fix/low-memory-asr`(기준 커밋 `e098f94`). 원래 2026-10-04 Claude → Codex 인계 문서였고, 커밋 `5566eaf`부터 받아쓰기 구조가 바뀌어 현재 코드에 맞게 다시 썼다. 공개 저장소: https://github.com/THISISMYCOSMOS/klasnote.
사용자 언어는 한국어, 에이전트 간 인계는 영어. 표시 이름은 `klasnote`(manifest `name`)이고 확장 ID(manifest `key`)·네이티브 호스트 이름 `com.klas_summarizer.host`·설치 폴더 `KlasSummarizer`·다운로드 폴더 `KLAS요약`은 그대로다. 구 브라우저 Whisper(transformers.js/ONNX/WebGPU) 설명은 모두 삭제했고 필요한 기록만 §9에 "역사"로 남겼다.

## 1. 제품 결정 (사용자 승인, 사용자 허락 없이 바꾸지 말 것)
- 광운대 KLAS 온라인 강의용 Chrome MV3 확장. 현재는 개인 학습용 비공개 프로토타입이며 배포는 별도 조건이 남아 있다(§6).
- 강의별 **자동 처리 스위치**(기본 OFF). ON인 강의를 학생이 열면(`lectureOpened`) 확장이 같은 mp4를 백그라운드에서 받아쓴다. 플레이어·KLAS 뷰어 창은 건드리지 않는다. OFF면 자동 작업 없음. "지금 요약" 버튼은 수동으로 받아쓰기를 시작한다.
- **받아쓰기는 사용자 본인의 Groq Free 계정 API 키로 Groq(`whisper-large-v3-turbo`)에 압축 음성(M4A)을 보낸다.** 이 PC에서 음성 인식 모델을 돌리지 않는다. 설정 화면의 Groq 음성 전송 동의(`asrConsent`)가 없거나 키가 없으면 `enqueue`가 거부한다. 개발자 공용 키는 없다.
- 받아쓰기가 끝나도 AI 호출·HTML 다운로드·CLI 감지는 자동으로 시작하지 않는다(`afterTranscription`은 상태만 `done`으로 바꾼다). 결과는 사용자가 고를 때만 만든다.
  - **원문 HTML 받기**: 받아쓰기가 끝난 강의는 AI 없이 HTML을 받을 수 있다(KLAS 목록 `HTML 받기`, 사이드패널 `HTML 받기`). 요약이 오류로 끝나도 받아쓰기 완료 표시(`transcribed`)가 남아 있어 원문 HTML은 계속 받을 수 있다.
  - **요약 노트**: AI 모드에서 `확인하고 저장`을 눌러 전송량을 확인한 뒤에만 AI를 호출한다(기본 `confirmBeforeSend`=true).
- 요약 AI는 사용자의 로그인된 `claude` 또는 `codex` CLI(native messaging). 요약용 API 키는 쓰지 않는다. 기본값(`policy.js` DEFAULT_SETTINGS): 모드 `local`, Claude `claude-opus-5-5`(선택: haiku/sonnet/opus/claude-opus-5-5), Codex `gpt-6-sol`(이 PC의 Codex 모델 목록에 있는 다른 모델도 선택 가능), 프리셋 `standard`.
- 산출물은 강의당 자체 완결 HTML 한 파일: 슬라이드 이미지 + 교수님 원문(슬라이드별) + (AI 모드일 때) 강의 전체 핵심·시험 포인트. 보기 전환 함께/요약만/원문만, AI 교정은 `<mark>`, 의심 구간은 물결 밑줄. 슬라이드별 AI 요약은 만들지 않는다(`summary.slides=[]`).
- 출석·진도·인증은 조작하지 않는다. KLAS Helper의 `bypassCertification`은 쓰지 않는다.
- 토큰 최소화는 필수 요구다(§5). 강의 요약은 열어 본 강의만 가능하다(`opened` 게이트, KLAS 진도 > 0이면 열린 것으로 인정).

## 2. 현재 파이프라인 (코드로 확인함)
1. **미디어 가져오기** (`extension/offscreen.js`, `src/core/media.js`): `content.php` XML에서 progressive mp4 주소를 얻고(`https://kwcommons.kw.ac.kr/` 한정), moov만 받아 샘플 표를 만든 뒤 HTTP **Range**로 구간(오디오 샘플 + 2초 간격 키프레임)을 한 번에 받는다. 구간당 상한 32 MiB(`PREFETCH_LIMIT`이면 구간을 절반으로 줄여 재시도), 실패 시 1.5초 뒤 한 번 재시도.
2. **리먹스** (`src/core/aac.js`): AAC 샘플을 디코딩·재인코딩 없이 M4A로 묶는다(10 MiB·121초 상한). PCM·모델 없음.
3. **전송** (`background.js` `nativeCall` → `native-host/host.mjs` → `native-host/groq.mjs`): offscreen이 base64 오디오를 background에 보내고, background가 `chrome.runtime.connectNative`로 호스트를 **요청마다 새로 띄워** 보낸 뒤 응답을 받으면 연결을 끊는다(최대 12분 대기). 호스트는 Groq `audio/transcriptions`에 `verbose_json`·segment·`language=ko`·`temperature=0`으로 보낸다. 호스트 자체에는 자동 재시도가 없고, Groq 요청 시간 초과 120초, 응답 2 MiB 상한.
4. **구간 경계** (`src/core/window.js` `commitWindow`): 확정 110초 + 꼬리 10초(`WINDOW=110, TAIL=10`)를 보낸다. 확정 범위(끝에서 꼬리 10초 전) 안에서 시작한 구간만 저장한다. 다음 구간 시작은 저장한 마지막 구간의 끝(그것이 `horizon−1초`보다 작으면 `horizon−1초`)이고, 보낸 오디오 끝까지 이어진 마지막 발화가 구간 후반에서 시작했다면 저장하지 않고 그 발화 시작점부터 다시 보낸다. 마지막 창은 전부 저장한다. 꼬리 구간에서 시작한 무음 환각은 이 규칙으로 버려진다.
5. **숫자 이중 확인** (`src/core/numcheck.js`, `offscreen.js` `recheckNumbers`): 창마다 숫자(아라비아 숫자)가 든 발화 최대 3개를 앞뒤 3초씩 붙여 다시 받아쓴다. 원래 숫자가 다시 안 나오면 `segment.numberCheck`에 대체 결과를 남긴다. 호출 간격 3.1초(Groq 무료 한도 분당 20회), 실패해도 강의 처리는 계속한다.
6. **슬라이드** (`src/core/slides.js`): 키프레임만 디코딩(소프트웨어 디코더 우선), 64×36 흑백 썸네일의 평균 절대차 > 0.04이고 4초 이상 유지된 화면을 새 슬라이드로 본다. JPEG 1280px로 저장. 중단 시 진행 중인 슬라이드를 `pending`으로 저장하고 `progressSec`부터 이어 받는다.
7. **의심 표시** (`src/core/suspect.js`, 표시는 `report.js`): 지우지 않고 표시만 한다. 초당 20자 초과, 무음에서 흔한 문구(감사합니다·자막 제공·구독과 좋아요·MBC 뉴스), 같은 말 반복, 숫자 재확인 불일치. `no_speech_prob`는 쓰지 않는다(turbo가 환각 구간에도 0.000을 줘서).
8. **요약** (`src/core/pack.js` → `host.mjs`): §5.

HTML에 표시하는 받아쓰기 모델명은 호스트가 응답한 `result.model`을 따른다(없으면 `MODEL` 기본값). 상태는 완료인데 이 Chrome 저장소에 받아쓰기가 없으면(다른 프로필·삭제) `download`가 상태를 `paused`로 되돌려 다시 받아쓰도록 안내한다. CLI 오류 중 Claude Code 버전이 낮다는 영어 메시지는 `friendlyError`가 `claude update` 안내로 바꾼다.

큐·오류 처리(`offscreen.js` `pump`): 한 번에 한 강의. Groq 한도(`GROQ_RATE_LIMIT`)는 `retryAt`까지 대기 후 자동 재개, 키 오류·일시 오류·모델 없음·호스트 연결 실패는 대기 상태로 두고 설정의 "연결 테스트·대기 재개"로 풀린다. 그 밖의 오류는 `error`, 사용자가 멈추면 `paused`. `playerAlive` 신호는 더 이상 동시 작업 수를 줄이지 않는다(no-op).

## 3. 확인된 외부 사실 (2026-10-04 실측, 다시 구하지 말 것)
- KLAS 목록 `https://klas.kw.ac.kr/std/lis/evltn/OnlineCntntsStdPage.do`: Vue `$data.list` 항목에 `sbjt`(제목), `starting`=`https://kwcommons.kw.ac.kr/em/<contentId>`, `prog`, `weekNo`, `moduletitle`, `sdate/edate`, `evltnSe`. 행은 `<tr>`의 `보기` 버튼. 여러 학습창을 열면 마지막 창만 출석으로 인정된다는 경고문이 있다.
- 메타데이터: `.../viewer/ssplayer/uniplayer_support/content.php?content_id=<id>` XML(제목, 길이, `main_media`, progressive `media_uri`). 자막 없음.
- mp4: 인증·쿠키 불필요, Range 지원(206), CORS 헤더 없음(→ `host_permissions`). 표본 743 MB / 3731초, H.264 1920×1050 약 15 fps, AAC 44.1 kHz 스테레오 84 kbps, moov 앞(faststart). 오디오가 프레임 단위로 섞여 있어 오디오만 Range로 받으면 비효율적이라 오디오+키프레임을 한 구간으로 받는다.
- 플레이어는 kwcommons iframe. `content/kw-player.js`는 URL에서 강의 ID만 읽는다. 실제 실행 시 iframe URL 모양은 미검증.
- 강의 발화 밀도 약 495자/분(구 small 측정). Groq 실측 정상 발화는 초당 2.9–11자.

## 4. 코드 지도
| 경로 | 역할 |
|---|---|
| `extension/manifest.json` | MV3, v0.1.5. 권한 storage·unlimitedStorage·offscreen·nativeMessaging·downloads·sidePanel, 호스트 권한은 `kwcommons.kw.ac.kr`만(Groq 호출은 호스트가 한다). 콘텐츠 스크립트는 KLAS 목록·상태 표시·KWCommons 플레이어 경로로 제한 |
| `extension/background.js` + `src/core/policy.js` | 서비스 워커. 발신자 분류·동의·`opened` 게이트·1회용 티켓+`packHash`·`nativeCall`·요약/다운로드·`reconcile`. 설정 정제, 요약 JSON 파싱(`parseSummary`, 교정 `parseCorrections`) |
| `extension/offscreen.js` | 받아쓰기 큐·재개·취소·Groq 한도 대기, 슬라이드 저장, pack/report/목록/삭제 핸들러 |
| `src/core/media.js · aac.js · window.js · numcheck.js · slides.js · suspect.js` | §2 |
| `src/core/store.js` | IndexedDB `klas-summarizer`: lectures·segments·slides·summaries |
| `src/core/pack.js · report.js` | AI 입력 구성(`SYSTEM`, `SUMMARY_FORMAT=lecture-points-v2`), 자체 완결 HTML(CSP 메타, 교정은 발화 단위) |
| `extension/content/*` | `klas-list-main.js`(MAIN 월드, Vue 읽기 전용) → `klas-list.js`(닫힌 Shadow DOM 컨트롤: 자동 처리·지금 요약·HTML 받기·상태), `klas-status.js`, `kw-player.js` |
| `extension/{sidepanel,options,consent,confirm}.*`, `campus.*`, `ui.css`, `note-launch.*` | UI. 설정에서 Groq 키 저장·삭제·연결 테스트(키는 `options.html` 발신자만 관리 가능) |
| `native-host/host.mjs · groq.mjs · host.bat` | 네이티브 호스트. 명령: `groqStatus·groqSaveKey·groqRemoveKey·groqTest·transcribeGroq·codexModels·detect·test·summarize`. Groq 키는 호스트 폴더의 `groq-config.json`(평문 JSON)에 저장하며 응답에 포함하지 않는다. 환경변수 `GROQ_API_KEY`도 대체 경로로 허용 |
| `install.cmd` → `scripts/setup.mjs` | 정식 설치 경로(§7). `install.ps1`은 배포 ZIP에 포함되지 않는 옛 경로다(2026-10-05에 빠져 있던 `groq.mjs` 복사를 추가함, 실행 검증은 하지 않음) |
| `tests/*.test.mjs`, `tools/` | Node 테스트(`npm test`). `tools/engine-harness.html`은 구 브라우저 Whisper 시절 하네스(`asrModel` 인자 등 옛 구조 기준)이며 현재 구조에서 동작하는지는 확인하지 않았다 |

제거된 것: `asr.js`, `asr-worker.js`, `processor.html`, `model-progress.js`, transformers.js/ONNX 번들과 라이선스 문구.

## 5. AI 요약·토큰 설계 (유지)
- `pack.js`: 슬라이드(S번호)별 **원문 발화**에 `#번호`를 붙여 보낸다. 군말 제거(`compact`)는 하지 않는다(교정 `from`이 원문에 없어 버려지던 문제, Groq 출력에서 줄이는 양은 1.2%). 숫자 불일치 발화에는 `[숫자 재확인: …]`을 덧붙인다.
- 이미지: 8초 이상 유지된 슬라이드를 오래 나온 순으로 프리셋 상한까지만(절약 10 / 표준 25 / 상세 60), 여백 자르기, 896/1024/1024 px, JPEG q0.7. 나머지는 텍스트만. 슬라이드가 없는 강의의 이미지 없는 한 칸은 이미지 인코딩을 건너뛴다.
- 프롬프트: `pack.js`의 `SYSTEM`과 `host.mjs`의 `SYSTEM`은 **같은 내용으로 유지**한다. 호스트는 프롬프트가 `강의: `로 시작하는 것만 받고(시스템 프롬프트는 호스트에 고정), 작업 지침을 user 입력(`<lecture_data>`)으로 전달한다. 문체·분량은 사용자의 개인 지침(CLAUDE.md/Codex 설정)이 우선한다.
- AI 출력: `{overview, slides:[], exam, corrections:[{id,from,to,s?}]}`. `policy.js`가 교정을 최대 40개, `from` ≤40자, `to` ≤80자로 정제하고, `report.js`는 지목된 발화 안에서 `from`이 **정확히 한 번** 나올 때만 적용한다(겹침·존재하지 않는 슬라이드 근거는 버림, 이스케이프는 조각마다).
- 호출: `claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence --tools "" --strict-mcp-config --setting-sources user,project,local --settings {"disableAllHooks":true} --disable-slash-commands --model <m>`(이미지 전부 한 user 턴). Codex는 `exec --json --skip-git-repo-check --ephemeral -s read-only -m <m> -c mcp_servers={}` + 셸·브라우저·플러그인·메모리 등 기능 `false` + 임시 폴더 `-C`. 작업 폴더는 매번 새 빈 임시 폴더.
- 확인 화면의 견적(`pack.estimate`)은 오버헤드 가정값(Claude 1,900 / Codex 15,300)을 쓴다. 개인 지침을 로드하는 현재 호출에서는 실제 사용량이 더 클 수 있다.
- 요약은 `contentId`별로 저장하고(`summaryFormat`이 현재 `lecture-points-v2`와 같을 때만 재사용) 사용자가 강제하지 않으면 다시 호출하지 않는다.

## 6. 정책·보안 결정 (레드/블루 1회 검토 결과, 현재 코드와 대조함)
| ID | 위험 | 현재 상태 |
|---|---|---|
| R1 | Codex 읽기 전용 샌드박스에서도 셸로 파일 유출(프롬프트 주입) | `codexArguments`에서 셸·플러그인·브라우저·MCP 등 비활성. 구 실측: 켜면 명령 실행, 끄면 실행 안 됨 |
| R2 | 교정 치환으로 HTML 속성 주입 | 원문에 단일 패스로 적용 후 조각별 이스케이프, CSP 메타(`default-src 'none'; img-src data:; script-src 'sha256-…'`) |
| R3 | 콘텐츠 스크립트·페이지가 offscreen/background를 직접 호출 | 발신자 분류(`classifySender`), offscreen은 확장 내부 발신자만, `contentId` 정규식, `isTrusted` 클릭, 다운로드 파일명 정제 |
| R4 | 서비스 워커 종료·호스트 고아 프로세스 | 호스트가 자식 프로세스·임시 폴더를 stdin 종료/SIGTERM 때 정리, `connectNative`+중지(abort) 처리 |
| R5 | `detail` 프리셋이 호스트 한도 초과 | 상세 60장 고정, 전송 묶음 64 MiB 미만 검사 |
| R6 | 강의 내용이 Anthropic/OpenAI로 나감, 열지 않은 강의 요약, 학교 규정 | 첫 실행 동의 화면, 로컬 전용 모드, 열어 본 강의만 허용. **새로 Groq로 음성이 나가므로 `asrConsent` 별도 동의**가 필요하다. 학교·강좌의 AI 이용 허용 여부와 배포·마스코트 사용 승인은 확인되지 않았다 |
| R7 | 같은 확장 키를 쓰는 복제 확장이 호스트를 범용 프록시로 사용 | 호스트가 명령·실행 파일·API 주소를 고정, 프롬프트 접두어 검사, `node.exe` 절대 경로 호스트 런처 |
| R8 | 개발 서버 노출 | 127.0.0.1 바인드 등(개발용). `tools/`·`tmp/`는 배포 제외 |
개인 학습용 한정(공유 서버·공용 토큰 캐시 없음), 각 사용자가 본인 계정을 쓴다.

## 7. 설치 흐름 (코드 기준)
- `install.cmd` → `scripts/setup.mjs --install-only`: `%LOCALAPPDATA%\KlasSummarizer`(Mac `~/Library/Application Support/KlasSummarizer`)에 `extension/`, `host.mjs`, `groq.mjs`, `host.bat`(`node.exe` 절대 경로), `host-config.json`, 소유 확인 파일을 쓰고, HKCU `Software\Google\Chrome\NativeMessagingHosts\com.klas_summarizer.host`를 등록한다(Mac은 NativeMessagingHosts 폴더). 다른 폴더·다른 호스트 등록이 있으면 보존하고 중단한다. 사용자는 `chrome://extensions`에서 설치된 `extension/` 폴더를 압축해제 로드한다.
- 처음 설정: 동의 화면 → 설정에서 Groq 키 저장·음성 전송 동의 → (선택) Claude/Codex 로그인. `groq-config.json`은 호스트 폴더에 저장되며 `uninstall.ps1`이 폴더째 삭제한다.
- `start.cmd` → `scripts/start.mjs`: 전용 Chrome 프로필로 확장을 연결하는 대체 경로(영구 등록 아님).
- 패키지: `scripts/build-package.mjs`가 `native-host/groq.mjs`를 포함한다.

## 8. 실측 (2026-10-05, 이 PC: Core Ultra 5 225H, 16 GB, Intel Arc 130T) 와 남은 일
측정값
- Groq turbo 30초 클립당 0.6–1.1초. 호출 클라이언트 최대 RSS 64 MiB. 네이티브 호스트 콜드 스타트 약 130 ms.
- 실제 확장으로 처리하는 동안 Chrome 전체 CPU 평균 1.9%, 최대 5.3%(확장 프로세스 0.3–2.8%), Chrome 메모리 1.4–1.9 GB로 증가 없음.
- 연결 실험: 창 경계에서 문장 누락·중복 없음. 무음 환각 "자막제공자"가 꼬리 규칙으로 버려짐. 연결 문맥에서 숫자 10%→20%로 바뀐 사례를 재확인이 표시함.
- 상세 기록과 구 측정은 `docs/asr-verification.md`.

알려진 한계
- 같은 모델의 재확인은 같은 오류를 반복할 수 있다. 한국어 수사("십 퍼센트")는 검사하지 않는다(숫자 정규식만).
- 무음 직후 타임스탬프가 무음 길이를 흡수할 수 있어 슬라이드와 어긋날 가능성이 있다(미검증).
- 새 프롬프트(`lecture-points-v2`, 발화 단위 교정, 숫자 재확인 문구)로 한 AI 요약 전체 E2E는 아직 없다.
- Claude Code CLI는 `claude-opus-5-5`를 쓰려면 2.1.280 이상이어야 한다(2026-10-05 2.1.289로 갱신해 쓰는 중).
- `npm test`: `e098f94`에서 110/110 통과(2026-10-05). 모의·합성 데이터 기준이며 실제 Chrome·Groq E2E가 아니다.

남은 일(순서대로)
1. 실제 KLAS 목록에서 컨트롤이 올바른 강의 행에 붙는지, `opened` 상태가 실제 iframe URL에서 오는지, 열지 않은 강의가 막히는지 확인. iframe URL 모양 확인.
2. KLAS Helper 동시 사용 시 원래 `보기` 버튼·인증·진도·표 구조가 정상인지 확인(Shadow DOM·읽기 전용 연동은 증거가 아님).
3. 설치된 확장으로 강의 한 편을 끝까지: Groq 받아쓰기 → 요약 확인 → AI 요약 → HTML 다운로드, 견적 대 실제 사용량 비교.
4. 학교 마스코트 PNG는 2026-10-04 사용자 결정으로 UI에서 제거했다(권리는 학교에 있음). 배포·마스코트·강좌 허가는 미확인, 메일은 보내지 않았다.

## 9. 역사: 구 브라우저 Whisper (더 이상 코드에 없음)
- 2026-10-04까지 `whisper-small`(transformers.js 4.3.0, Chrome WebGPU, Intel Arc 130T)을 브라우저에서 실행했다(RTF 0.69, 이후 base/fp16 전체 강의 RTF 0.255). `whisper-large-v3-turbo`는 이 PC에서 `std::bad_alloc`으로 실패했다. 또 당시 Chrome 메모리가 약 1.7 GB 늘었고 WebGPU 실패도 있었다. 이후 Groq로 전환했다. 측정 상세는 `docs/asr-verification.md`의 역사 절.
- Windows Smart App Control이 서명 없는 네이티브 DLL(faster-whisper의 `av`·`ctranslate2`)을 막아 로컬 네이티브 인식은 쓰지 않았다. 우회하지 않는다.
- 구 토큰 실측(구 호출 옵션 기준): `claude -p` 기본 오버헤드 52,611, 구 최소 옵션 1,815(`--system-prompt` 대체·개인 설정 제외 시), Codex 약 15–23k. 현재는 개인 설정을 로드하므로 그대로 쓸 수 없다. 1분 발췌+이미지 1장 Sonnet 입력 3,885/출력 695, Codex(terra) 이미지 1장 16,544/372도 구 옵션 기준이다.
