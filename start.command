#!/bin/sh
# macOS: Finder에서 더블클릭하거나, 터미널에서 sh start.command 로 실행합니다.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do [ -x "$d/node" ] && PATH="$d:$PATH"; done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js LTS가 필요합니다: https://nodejs.org/"
  read -r _
  exit 1
fi
node scripts/start.mjs || { echo "실행하지 못했습니다. 위 오류를 확인하세요."; read -r _; exit 1; }
