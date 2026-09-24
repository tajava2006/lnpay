# admin/legacy — 데몬으로 옮기기 전 옛 온체인 어드민 코드

프론트 어드민 시절의 **온체인** 집행 코드와 그 테스트다. 라이트닝 쪽은 데몬 P3에서 새로 짜면서 지웠다.
여기 있는 건 PLAN-DAEMON P4에서 `daemon/src/onchain/`으로 **`git mv`** 해 이력째 옮긴다.

**컴파일도 테스트도 하지 않는다**(`admin/tsconfig.json`의 include가 `src`뿐, vitest도 `src/**`만).
상대 import가 끊겨 있는 게 정상이다 — 끊긴 곳(escrow-store, 옛 notify 등)은 데몬에서 다른 모양으로 대체된다.
