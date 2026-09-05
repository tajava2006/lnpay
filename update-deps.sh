#!/usr/bin/env bash
# 의존성 한방 최신화 (주기 실행)
#
# 이 앱은 아무도 라이브러리로 가져다 쓰지 않는 최말단이라, 버전을 붙잡고 있을 이유가 없다.
# 항상 latest를 따라가고 깨지면 그때 고치는 게, 몇 달치 breaking을 한꺼번에 맞는 것보다 싸다.
# 개별 패키지를 나열하지 않는 것도 같은 이유 — 새 의존성이 추가돼도 목록 갱신을 잊을 일이 없다.
set -euo pipefail
cd "$(dirname "$0")"

echo "== JS 의존성 (워크스페이스 전부 latest) =="
pnpm up --latest -r

echo "== 테스트 =="
pnpm test

echo "== 빌드 검증 (customer/sponsor/admin) =="
pnpm -r build

echo "== 유저스크립트 빌드 검증 =="
pnpm build:userscript

echo ""
echo "⚠️ 정적 배포물이라 빌드가 통과해도 런타임 회귀는 안 잡힌다."
echo "   admin 로그인 + 주문 1건 왕복 스모크 후 배포할 것."
