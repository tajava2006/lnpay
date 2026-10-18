# 지정 거래 브랜치 2차 코드 리뷰

> **임시 문서.** `feat/designated-trade`(@ `e083151`)를 다시 훑은 결과다. 1차 리뷰는
> [REVIEW-DESIGNATED-TRADE.md](REVIEW-DESIGNATED-TRADE.md)에 따로 있다. 반영이 끝나면 이 파일을 지운다.
> 줄 번호는 `e083151` 기준이라 고치다 보면 밀린다 — 함수 이름으로 찾는다.

## 0. 결론

**자금이 잘못 움직이는 버그는 없다.** 다만 ① 후원자 인보이스 마감(6시간)이 핸들러에서 강제되지 않아
드물게 고객 BTC가 최대 7일 묶일 수 있고, ② 지정 거래가 보증금 없이 푸시·목록 스팸 경로가 된다(설계 판단).
나머지는 문구·기준 시각·운영 편의 수준이다.

검증: `pnpm verify` 통과(shared 567 · customer 169 · admin 30 · daemon 354),
`pnpm build:customer`·`pnpm build:admin`·`pnpm build:daemon` 통과.

## 1. 우선순위

| ID | 등급 | 한 줄 | 위치 |
|---|---|---|---|
| R2-1 | **중간** | 후원자 인보이스 마감 검사가 핸들러에 없어 6시간 상한이 좁은 창에서 우회됨 | `daemon/src/ln/handlers.ts:148` (`sponsorInvoice`) |
| R2-2 | **중간·설계** | 지정 거래가 보증금·속도 제한 없이 푸시·목록 스팸 경로 | `daemon/src/ln/handlers.ts:106`, `daemon/src/onchain/handlers.ts:154` |
| R2-3 | 낮음 | 온체인 지정 의뢰의 pending 안내가 "보증금 인보이스"를 기다린다고 말함 | `customer/src/onchain/components/OnchainOrderForm.tsx:101`, `OnchainMyOrders.tsx:73` |
| R2-4 | 낮음 | 인보이스 마감 기준이 실제 수락 시각이 아니라 관측 시각 | `daemon/src/ln/flow.ts:340` |
| R2-5 | 낮음 | 운영자 추가 시 기존 지정 거래 스냅샷이 새 운영자에게 안 감 | `daemon/src/ln/effects.ts:220`, `daemon/src/onchain/effects.ts:58` |
| R2-6 | 사소 | `RISKS.md`의 R-16이 R-15보다 위에 있음, `copy.ts` 끝 빈 줄 | `docs/RISKS.md:31`, `shared/src/copy.ts:38` |

## 2. 중간

### R2-1. 후원자 인보이스 마감을 핸들러가 강제하지 않아 6시간 상한이 우회된다

**문제.** `sponsorInvoice`(`daemon/src/ln/handlers.ts:148`)는 `state === 'escrowed'`면 인보이스를 받는데
`invoice_deadline` 검사가 없다. 마감은 워처만 닫는다(`daemon/src/ln/watcher.ts:163`).

틱 순서는 `dispatcher.runPending()` → `ln.watcher.poll()`이다(`daemon/src/runtime.ts:174-177`).
재시작 직후 `CATCHUP_WARMUP_SEC`(2분) 동안은 만료를 닫지 않는다(`daemon/src/ln/watcher.ts:81`).

**재현 조건.**
1. 고객이 에스크로를 냈고 후원자가 `INVOICE_WINDOW_SEC`(6시간) 동안 인보이스를 안 냈다.
2. 마감 직후, 다음 워처 틱 전(최대 15초 — `LNPAY_TICK_MS` 기본값) 후원자가 `sponsor-invoice`를 보낸다.
3. 디스패처가 먼저 처리해 `escrowed → invoiced`로 전이한다.
4. 이후 `closeAt`은 `invoiced`를 `deadline + DEADLINE_GRACE_SEC`로 본다(`watcher.ts:164`). 고객 BTC는
   마감(에스크로 수락 + 6시간)이 아니라 **기한 + 1시간**까지 묶인다 — 기한이 7일이면 최대 7일이다(R-5 재발).

데몬이 마감을 넘겨 재시작한 경우에는 워밍업 2분 동안 같은 일이 가능해 창이 넓다.
자금이 사라지는 건 아니고 **환불이 늦어지는 지연**이다. 후원자 키로만 트리거되고 창이 좁아 실제로 만날 확률은 낮다.

**1차 리뷰와 충돌.** 1차 문서 §5는 "후원자 인보이스가 새 6시간 마감과 경합? 없음"이라고 적었다. 근거로 든
`escrowed → invoiced` 동기 전이는 마감 **전** 인보이스에는 맞지만, 마감 **후** 인보이스를 거절하는 검사가
아니다. 위 경로가 남아 있으므로 1차 판단을 뒤집는다.

**수정 방향.**
- `state === 'escrowed'`일 때 `invoice_deadline`을 넘긴 요청은 거절한다. `requestAt` 기준으로 보면 된다
  (`remitRequest`가 같은 패턴 — `daemon/src/ln/handlers.ts:70`).
- 마감 직후 인보이스 요청이 거절되는 테스트를 추가한다(프로덕션이 부르는 dispatch 경로로).

### R2-2. 지정 거래가 무비용 스팸/알림 폭탄 경로다

**문제.** LN `designatedOrderRequest`(`daemon/src/ln/handlers.ts:106`)와 온체인 `ocDesignatedOrderRequest`
(`daemon/src/onchain/handlers.ts:154`)는 **고객 보증금 없이** 바로 오더를 만들고, 지정 후원자에게 푸시
(`daemon/src/ln/notify.ts:77`, `daemon/src/onchain/notify.ts:52`)와 운영자 DM
(`daemon/src/ln/store.ts:87`, `daemon/src/onchain/store.ts:113`)을 보낸다.

상대 npub만 알면 누구나 특정 후원자에게 무한정 지정 의뢰를 만들 수 있다. 공개 오더북 스팸과 달리
**지정 후원자 쪽에 새로운 무비용 경로**가 생긴다. 운영자가 `customerDepositPct`를 켜도 지정 거래는 우회한다.
R-16은 "상대가 사라지는" 위험만 다루고 이 방향은 언급하지 않는다.

**선택지.**
1. 감수하고 `docs/RISKS.md` R-16에 명시.
2. 고객 pubkey당 열린 지정 오더 개수 상한.
3. 지정 대상 pubkey당 도착 푸시 시간창 dedup — 목록 스팸은 남는다.
4. `customerDepositPct`를 지정 거래에도 적용 — "보증금 없는 1:1" 취지와 충돌.

방향이 정해지기 전에는 구현하지 말고, 최소한 R-16에 이 경로를 적는다.

## 3. 낮음

### R2-3. 온체인 지정 의뢰의 pending 안내가 보증금 인보이스를 기다린다고 말한다

`rememberPendingRequest`(`customer/src/onchain/components/OnchainOrderForm.tsx:101`)가 지정 여부를 저장하지
않아, `OnchainMyOrders.tsx:73`이 지정 의뢰에도 "운영자가 보증금 인보이스를 보내기를 기다리는 중입니다"라고
표시한다. 지정 거래는 보증금 인보이스가 없으므로, 스냅샷이 늦거나 유실되면 오지 않을 인보이스를 기다리게 된다.
`PendingOrderRequest`에 `designated`를 저장하고 문구를 분기한다.

### R2-4. 인보이스 마감 기준 시각이 관측 시각이다

`onEscrowAccepted`(`daemon/src/ln/flow.ts:340`)가 `nowSec(ctx)`(관측 시각)로 `invoice_deadline`을 찍는다.
데몬이 오래 꺼져 있다가 에스크로 수락을 늦게 관측하면 6시간 창이 재시작 시점부터 다시 시작한다
(기한 + 유예 상한은 유지). 계획의 "에스크로 수신 + 6시간"과는 다르다. 실제 수락 시각을 `HoldRow`에 남기거나,
관측 지연을 감안한 값이라는 의도를 문서에 명시한다.

### R2-5. 운영자 추가 시 기존 지정 거래가 새 운영자에게 안 간다

`buildOrderEvents`(`daemon/src/ln/effects.ts:220`)와 `createOcPublishExecutor`
(`daemon/src/onchain/effects.ts:58`)는 발행 시점의 `ctx.operators`에게만 스냅샷을 낸다. 운영자를 나중에
추가하면 상태가 더 바뀌지 않는(특히 종결된) 지정 거래는 새 운영자 앱에 보이지 않는다. 운영자 목록 변경 시
진행 중·최근 지정 거래를 재발행하거나, 운영자 추가 런북에 이 한계를 적는다.

## 4. 사소한 것

- `docs/RISKS.md:31` — R-16이 R-15보다 위에 있다(번호 순서).
- `shared/src/copy.ts:38` — 파일 끝 불필요한 빈 줄(`git diff --check`).

## 5. 끝내기 체크

- [ ] R2-1 수정 + 마감 후 인보이스 거절 테스트
- [ ] R2-2 방향 결정(최소 RISKS R-16 기재)
- [ ] R2-3~R2-5 반영 여부 결정
- [ ] R2-6 정리
- [ ] `pnpm verify` + 영향받는 앱 빌드 통과
- [ ] 이 파일 삭제
