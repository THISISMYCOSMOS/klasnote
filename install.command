#!/bin/sh
# macOS 평소 Chrome용 설치: 터미널에서 sh install.command (또는 Finder에서 오른쪽 클릭 → 열기)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do [ -x "$d/node" ] && PATH="$d:$PATH"; done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js LTS가 필요합니다: https://nodejs.org/"
  read -r _
  exit 1
fi
node scripts/setup.mjs --install-only || { echo "설치하지 못했습니다. 위 오류를 확인하세요."; read -r _; exit 1; }
EXT="$HOME/Library/Application Support/KlasSummarizer/extension"
printf '%s' "$EXT" | pbcopy 2>/dev/null
echo ""
echo "설치 완료. 확장 폴더 경로를 클립보드에 복사했습니다:"
echo "  $EXT"
echo "평소 Chrome에서 한 번만: chrome://extensions → 개발자 모드 켜기 → [압축해제된 확장 프로그램을 로드합니다]"
echo "→ 폴더 선택 창에서 Cmd+Shift+G 를 누르고 붙여넣기(Cmd+V) → 이동 → 선택"
open "$EXT" 2>/dev/null
