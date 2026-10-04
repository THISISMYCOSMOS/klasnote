# HANDOFF — klas-summarizer (Claude → Codex)

Date: 2026-10-04. Primary implementer from here: **Codex**. Historical Claude handoff updated by Codex. Source publication target: https://github.com/THISISMYCOSMOS/klasnote.
User-facing language: Korean. Agent handoff: English.

## 1. Product (user-approved decisions — do not change without the user)
- Chrome MV3 extension for Kwangwoon Univ. KLAS online lectures. Current delivery is a private runnable prototype; distribution is pending the separate conditions below.
- **Mode B**: per-lecture **switch** (default OFF). When ON and the student opens that lecture, the extension processes the same mp4 in the background (never touches the player, never opens KLAS viewer windows). Local mode saves HTML automatically; AI mode asks for confirmation by default, and only runs automatically if the user explicitly turns that confirmation OFF. OFF = zero work, zero tokens.
- "지금 요약" button per lecture: manual run, asks for confirmation; token estimate is shown for AI mode.
- Transcription is **local only** (browser Whisper, 0 tokens). All data stays local (IndexedDB + downloaded file). Only the summary step sends the token-minimized transcript + selected slide images to the user's own Claude/Codex account.
- AI providers: user's logged-in `claude` CLI or `codex` CLI via native messaging. **No API keys.** Claude default model **Sonnet** (options: haiku/sonnet/opus). **Codex fixed to `gpt-5.6-terra`** (user decision).
- Output: one self-contained **HTML** per lecture: slide image + AI summary/comment + 교수님 원문 (verbatim local transcript) per slide; view toggle 함께/요약만/원문만; AI-returned `corrections` are applied to the verbatim locally and highlighted with `<mark>`.
- Token minimization is a hard requirement (see §4).
- Never manipulate attendance/progress. Do not reuse KLAS Helper's `bypassCertification`.

## 2. Verified facts (measured 2026-10-04 on the user's PC; do not re-derive)
- KLAS list page `https://klas.kw.ac.kr/std/lis/evltn/OnlineCntntsStdPage.do`: Vue instance whose `$data.list` items have `sbjt` (title), `starting` = `https://kwcommons.kw.ac.kr/em/<contentId>`, `prog`, `weekNo`, `moduletitle`, `sdate/edate`, `evltnSe` (`lesson`). Rows are `<tr>` with a `<button class="btn2 btn-gray">보기</button>`; title in the 4th `td.lft`. Page text warns: opening several study windows → only the last counts for attendance.
- Metadata: `https://kwcommons.kw.ac.kr/viewer/ssplayer/uniplayer_support/content.php?content_id=<id>` → XML (title, duration, `main_media`=screen.mp4, progressive `media_uri` template `.../contents5/KW10000001/<id>/contents/media_files/[MEDIA_FILE]`). No captions.
- mp4: no auth/cookies required, Range supported (206), **no CORS headers** → needs `host_permissions`. Sample: 743 MB / 3731 s, H.264 avc1.640028 1920×1050 ~15 fps, keyframe every ~1 s; AAC 44.1 kHz stereo 84 kbps; moov at front (faststart, 2.25 MB). Audio is interleaved per video frame (byte-range for audio-only is inefficient) → we fetch **120 s windows** (≈12 MB/min) and extract both tracks.
- Player: kwcommons iframe (KLAS Helper injects into `https://kwcommons.kw.ac.kr/*` all_frames; video element `.vc-vplay-video1`). Our `content/kw-player.js` must only read the id. **Unverified**: exact iframe URL shape at runtime (we never opened the viewer).
- Windows **Smart App Control** blocks unsigned native DLLs (faster-whisper `av`, `ctranslate2`: "DLL load failed … 응용 프로그램 제어 정책"). Do not bypass. Hence browser Whisper.
- Browser Whisper (transformers.js 4.3.0, vendored, Chrome WebGPU on Intel Arc 130T): `whisper-small` encoder fp16 + decoder q4: **RTF 0.69** with our quiet-point splitting (was 0.92 with built-in stride; stride also duplicated text at chunk boundaries). Decoder fp16: RTF 1.05 (worse). `whisper-large-v3-turbo`: **fails** `std::bad_alloc` (15 GB RAM iGPU). First model download ~66 s; cached afterwards (~11 s load).
- Korean quality (small): understandable, systematic mis-hearings (주속값→주소값, 이미의→임의의, 노트→노드). Slide context lets the LLM fix them → `corrections` design.
- Token overhead per call: `claude -p` default **52,611**; with host flags **1,815** (measured through host.mjs). One 1280px slide ≈ 1,160 tokens. Codex terra overhead ≈ **22.7k** (text 22,650; +image 23,760), measured through host.mjs. Codex default model in the user's config (`gpt-6.1-sol`) is rejected for ChatGPT accounts — always pass `-m`.
- `claude --bare` needs an API key → unusable with subscriptions.
- Transcript density ≈ 495 Korean chars/min.

## 3. Code status (updated 2026-10-04)
| Path | Status |
|---|---|
| extension/manifest.json | all referenced files exist; fixed ID verified; page injection restricted to KLAS list / KWCommons player paths |
| extension/background.js + src/core/policy.js | implemented; sender/consent/opened gate, single-use bound ticket, cache, native port abort, local/manual vs automatic flows covered by 16 Node tests; installed Chrome messaging/download E2E unverified |
| extension/offscreen.html + processor.html + offscreen.js | implemented queue, cancellation, resume, pack/report/cache API and WebGPU fallback tab; full real lecture through extension unverified |
| extension/src/core/media.js / slides.js / asr.js | prior spike evidence below remains historical; decoder/bitmap finally cleanup and model dispose on change/30sec idle added; current full-lecture GPU/memory not measured |
| extension/src/core/store.js / pack.js / report.js | 8 synthetic browser integration checks passed (IndexedDB, crop/pack/estimate, cache, HTML escaping/CSP/correction, delete); generated HTML view toggle also verified in browser |
| extension/content/* | implemented; read-only Vue, own namespaced messages, trusted controls in closed Shadow DOM within existing 보기 cell; storage-change updates without periodic polling; actual KLAS Helper coexistence unverified |
| extension/{sidepanel,popup,options,consent,confirm}.* + campus.* + ui.css | Claude isolated frontend implemented and cross-reviewed; Chrome right-side panel, compact first setup, shared fonts, collapsed 3-step help, event refresh, persistent motion toggle; synthetic state/actions and in-panel confirmation checked; native panel visual opening unverified |
| native-host/host.mjs | previous provider tests remain historical; current actual native protocol detect/rejection tests pass, current installed host.bat detect passes; actual new AI summary not re-run |
| install.ps1 / uninstall.ps1 | parser checked, ownership/path/registry collision checks before install writes; current-user install completed; uninstall WhatIf checked (not actual removal) |
| README.md / .gitignore | Korean install/privacy/limits/verification instructions written; publication uses an isolated clone of the user-provided GitHub repository |

## 4. Token-minimization design (implemented in pack.js/host.mjs; keep it)
1. Claude flags: `--system-prompt <short> --tools "" --strict-mcp-config --setting-sources project --disable-slash-commands --no-session-persistence`, stream-json stdin with all images inline in **one** user turn (no Read-tool round trips).
2. AI never rewrites the transcript; returns per-slide ≤3 bullets + 1 comment + `corrections` (≤40) + overview + exam points. Verbatim stays local in HTML.
3. Filler removal + per-slide grouping, timestamps per slide only.
4. Images: only slides shown ≥8 s, ranked by duration, capped by preset (절약 10 / 표준 25 / 상세 60), content-cropped, 896–1024 px, JPEG q0.7. Others text-only.
5. Estimate shown before sending; cache summary per contentId (never re-summarize unless user asks).

## 5. Remaining work (ordered; implementation and local checks completed)
1. Completed registration in actual Google Chrome 154 through the official Extensions lifecycle API: own extension and KLAS Helper 2.2.1 both enabled, service worker running and default storage initialization verified. Because Chrome removes CDP-installed extension registrations on restart, the supplied private-profile launcher reconnects them on each run. This is not a permanent installation into the user's default Chrome profile. Initial local/AI setup is shown only while consent is unset. New sidePanel permission/path registration and storage retention across reconnections passed. Real Chrome panel visual opening, UI messaging/native ports/download E2E remain unverified.
2. On the actual KLAS online lecture list, confirm controls map to correct lecture rows, opened-once state comes from the actual frame URL, and unopened lectures are blocked. Inspect actual iframe URL shape; extend the narrow allowed path only if observed evidence requires it.
3. Verify simultaneous KLAS Helper operation: original 보기 button, certification/attendance/progress, lecture controls, table structure and styles remain functional. Shadow DOM/read-only integration reduces conflicts but is not proof of real coexistence.
4. Run one full lecture through the installed extension; measure wall time, GPU/memory while watching, and compare estimated vs actual AI usage if user chooses AI. Confirm downloaded self-contained HTML and cache retry. No automatic attendance window opening; do not claim full lecture completion from the synthetic checks.
5. The user requested public source publication including the four Uni mascot PNGs. Their rights remain with the university; usage/adaptation approval and course/university handling permission remain unverified. Official application originals, filled copy/paste text, email draft and policy research are in the Codex task outputs; no email was sent and no approval received.

### Decisions and handoff ownership
- Human selected Claude as technical lead/reviewer; Codex executes backend/integration/verification. Frontend worked in a separate snapshot and reviewed changes were integrated into the project once.
- Manual/automatic summary restricted to lectures opened at least once; this does not prove attendance or legal permission. Personal study only, no shared HTML distribution feature, no common server/first-user token cache. Each user uses their own account usage.
- Initial mode defaults local; AI is chosen explicitly, confirm-before-send defaults ON. No API keys. Existing summary schema remains overview3–5sentences, per-slide≤3bullets+comment, exam3–7, confident corrections≤40.
- User requested concise UI and restrained motion: shared typography, compact side panel, one initial setup, advanced settings/notices collapsed, primary centered. Motion uses small official Uni PNG plus static SVG/CSS transforms; OFF, hidden tab, and reduced-motion stop decorative movement. Official mascot approval remains pending.
- Local evidence: 16 Node checks, 8 synthetic browser data checks + rendered HTML view toggle, synthetic UI setup/retry/motion checks, manifest ID/references, PowerShell parsing/current-user native installation/installed launcher detection. Prior §2/§7 provider/ASR measurements are prior spike evidence, not newly repeated installed-extension E2E.

## 6. Red/Blue review (one round: Red = independent Opus reviewer, Blue/resolution = Claude primary)
| ID | Red finding | Blue response | Resolution / status |
|---|---|---|---|
| R1 High | Codex `-s read-only` still has a shell → prompt injection in lecture audio/slides can read local files (e.g. `~/.codex/auth.json`) and exfiltrate via output | Accepted. | **Fixed + verified** in host.mjs: `features.{shell_tool,unified_exec,apps,plugins,browser_use*,computer_use,memories,code_mode_host,...}=false`, `mcp_servers={}`. Benign test "run `echo KLAS123`": tools ON → `command_execution` ran; tools OFF → no execution, model answered `NO_TOOLS`. Side effect: Codex overhead 22.7k → ~15.2k tokens. Residual: user-level `~/.codex/AGENTS.md`/config still loaded (not a tool path). |
| R2 Med-High | Sequential corrections over escaped HTML allow attribute injection (PoC with `onfocus`) | Accepted (Red's PoC reproduced). | **Fixed + verified**: single-pass regex over raw text, escape per piece, length caps; CSP meta `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-…'`. PoC now renders as inert text; toggle script still works under CSP (checked in Chrome). |
| R3 Medium | Offscreen accepted messages from content scripts; `handlers[cmd]` matched inherited props; page-supplied title wins; MAIN-world postMessage forgeable | Accepted. | **Fixed in offscreen.js**: only extension-origin non-tab senders, `Object.hasOwn`, contentId regex `^[0-9a-f]{8,32}$`, server title preferred, page meta length-capped. **Implemented + locally checked** in content/background: `e.source===window`, strict id regex, `isTrusted` click + extension-owned confirm, `textContent` only, download filename sanitization (`\/:*?"<>|`, control chars, trailing dots, CON/PRN/...). |
| R4 Medium | SW may be killed during long `sendNativeMessage`; host `process.exit` on stdin end orphans CLI + leaves temp files | Accepted (SW 5-min limit itself not verified here). | **Host fixed**: tracks children/temp dirs, kills/cleans on stdin end/SIGTERM/SIGINT (normal runs verified: 0 leftover `klas-sum-*`; disconnect path untested). **Implemented + mocked cancel/replay tests**: background uses `chrome.runtime.connectNative`; actual installed Chrome port lifecycle still unverified. |
| R5 Medium | `detail` preset unbounded vs host cap 80 → fails after user approved | Accepted. | **Fixed**: detail capped at 60. Background total payload check (< 64 MiB) implemented and Node-tested. |
| R6 Medium (policy) | Content leaves PC to Anthropic/OpenAI; "summarize now" allows unwatched lectures; unauthenticated full download; distribution may breach KW rules | Partially accepted. Cloud flow is inherent and was disclosed to the user; background fetch is naturally paced (~17 MB/min at RTF 0.69), not a bulk scraper. | **Accept**: first-run consent screen naming the data flow + local-only mode (transcript/HTML without AI). **Human decided**: restrict to opened-once personal study; no sharing server or common cache. Public KLAS policy search did not establish AI permission; distribution/mascot approval not received. |
| R7 Low-Med | Public `key` lets a copycat unpacked extension reach the host; host accepted arbitrary system/prompt (general proxy) | Partially accepted: a copycat needs local install = attacker already has local code exec. | **Fixed**: system prompt hard-coded in host, prompt must start with `강의: `. **Implemented + installed**: host to `%LOCALAPPDATA%` with absolute `node.exe` path (not OneDrive/PATH). |
| R8 Low | devserver bound to all interfaces, prefix path check, CSRF-able `/dump` | Accepted (dev-only). | **Fixed**: bind 127.0.0.1, `root + sep`, same-origin check on `/dump`. Exclude `tools/` and `tmp/` from distribution. |

Verdict after resolution: confirmed exploit paths (R1, R2) closed and verified; R3/R4/R5 background/content requirements are implemented and locally checked; installed-extension E2E remains unverified. R6 product choices are resolved as personal/opened-once/local-default with explicit AI confirmation; university/course permission remains unknown.

## 7. Measured token cost (Sonnet via host, 2026-10-04)
- 1-minute excerpt + 1 slide image: **input 3,885 / output 695**. JSON schema followed; 4 useful corrections.
- Extrapolation for a 60-min lecture, preset 표준 (estimate, not measured): input ≈ 1.9k overhead + ~18–22k transcript + 25 images × ~0.8k ≈ **40–45k**, output ≈ 4–6k. For scale: a single default `claude -p` call costs 52.6k input tokens of overhead alone.
- Codex (terra, tools off) via host: 1 image + short prompt = **16,544 input / 372 output**.

패널은 확장 아이콘 또는 상태 표시를 눌렀을 때 열립니다. 처리 완료 시 자동으로 열지 않습니다. KLAS 상단에 독립 상태 버튼을 두고, 상단 영역을 찾지 못하면 오른쪽 아래에 표시합니다. 상태 표시는 처리 중/확인 필요/오류/대기만 조회하며 요약 엔진을 시작하지 않습니다. KLAS Helper 전역 변수·스타일·이벤트를 사용하지 않습니다.
