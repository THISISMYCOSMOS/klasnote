#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js LTS를 설치한 뒤 다시 실행하세요: https://nodejs.org/'
  exit 1
fi
node scripts/diagnose.mjs
