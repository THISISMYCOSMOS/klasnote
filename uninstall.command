#!/bin/sh
# macOS 제거: 설치 폴더와 Chrome 연결 등록을 지웁니다. 확장의 강의 기록은 Chrome 안에서 따로 지우세요.
cd "$(dirname "$0")" || exit 1
node scripts/setup.mjs --uninstall
read -r _
