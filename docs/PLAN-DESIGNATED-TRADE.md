# 지정 거래 (보증금 없는 1:1 거래) + 라이트닝 인보이스 마감 — 플랜

> **진행 중 플랜** — 이 문서 하나로 이어서 작업할 수 있게 썼다(2026-10-17 승인). 브랜치 `feat/designated-trade`.
> 단계를 끝낼 때마다 §12의 체크박스를 채우고 같은 커밋에 넣는다. 다 끝나면 내용을 트랙 문서로 녹이고 이 문서는 지운다
> (옛 PLAN 문서들처럼). 조사 기준: master `756f34c`.

---

## 0. 한눈에

- **무엇:** 서로 미리 합의한 두 사람이 **보증금 없이** 거래할 수 있는 "지정 거래"를 라이트닝·온체인 두 트랙에 만든다.
  고객이 **상대(후원자) pubkey를 지정**해 의뢰를 만들면, 그 의뢰는 **지정된 후원자와 운영자에게만 보이고**(암호문)
  **지정된 후원자만 맡을 수 있다**. 공개 오더북에는 안 뜬다.
- **덤:** 라이트닝 **인보이스 등록 마감 6시간**(트롤이 고객 BTC를 묶어 두는 시간 상한: 최대 7일 → 6시간).
- **공개 오더북은 그대로**(보증금 있음). 공개 보증금은 운영 설정 + 0%면 어드민 경고.
- 진행 체크: §12 단계표의 체크박스.

## 1. 왜 (배경)

### 보증금 딜레마
신원 없이 쓰는 공개 오더북에서 아무나 공짜로 "찜"할 수 있으면 트롤을 막을 수단은 원리상 둘뿐이다 — **찜에 비용을
물리거나(보증금·수수료)**, **누군지 알거나(신원·평판)**. 신원·레벨은 의도적으로 뺐으니 비용, 즉 보증금이다. 그런데
"실패하면 돌려주는" 보증금은 **홀드 인보이스**가 필요하고, 거기서 사용성 문제가 전부 나온다:

- 홀드 인보이스를 제대로 다루는 지갑이 제한적이다(RoboSats·Mostro도 같은 문제를 안고 있다 — 이 조합의 성질).
- 커스터디얼 지갑은 취소된 홀드의 잔고 복구가 운영사 처리에 달려 있어 보장이 없다.
- **라이트닝 지갑 자체가 없는 사람**(가끔 온체인으로 DCA만 하는 사람 — 제일 많은 층)은 아예 못 쓴다.
  지금 **온체인 트랙도 보증금이 LN 홀드 인보이스**라 이 사람들은 온체인 트랙조차 못 쓴다.

### 실제로 겪은 것
유저가 거의 없을 때 보증금 0%로 운영해 봤다 → 라이트닝 의뢰 하나 올리자마자 트롤이 찜하고 잠수탔다.
**사람 수가 적은 것과 트롤이 없는 것은 다른 문제다** — 트롤 한 명의 비용이 0이면 한 명이면 충분하다.

### 결론
"공개 오더북"이라는 전제를 빼면 문제가 사라진다. 실제 피드백에서 가장 실사용에 가까운 쓰임은 **다른 곳(게시판·커뮤니티)
에서 이미 합의한 두 사람이 에스크로만 쓰는 것**이다. 이 경우 **상대를 묶으면** 트롤은 손을 댈 수 없고, 남는 위험은
"내가 고른 상대가 째는 것" 하나 — 합의 거래의 전제 그대로다. 그래서 보증금이 필요 없다. 이 길이 생기면 공개 오더북은
보증금을 받는 쪽으로 운영해도 된다(보증금 없이 하고 싶은 사람은 지정 거래로).

## 2. 결정 (합의 완료)

| # | 결정 |
|---|---|
| D1 | **두 트랙 다** 만든다. 라이트닝이 쉽지만 온체인이 더 필요하다(LN 없는 사용자의 첫 경로) |
| D2 | **상대를 pubkey로 묶는다.** 지정된 후원자만 맡을 수 있다(데몬이 검사) |
| D3 | **지정된 사람 말고는 볼 수도 없게** — 의뢰는 공개 오더 이벤트(38383)로 내지 않고, **수신자별 암호문 스냅샷**으로 고객·지정 후원자·운영자에게만 보낸다 |
| D4 | **링크 공유 없음.** 후원자가 자기 주소(npub)를 다른 채널(카톡 등)로 알려 주면, 고객이 그걸로 지정 거래를 만들고 **후원자 앱에는 자동으로 뜬다**(nostr로). 다른 채널은 "주소 전달" 한 번에만 쓴다 |
| D5 | 화면에 **확인 코드**(npub 앞·뒤 일부)를 양쪽에 보여 주고, 고객이 "상대 화면의 코드와 같다"를 확인한다 — 잘못 붙여넣은 주소로 남에게 무담보 의뢰가 가는 걸 막는다 |
| D6 | 지정 거래는 **보증금 없음**(고객·후원자 둘 다). 대신 생성·수락 때 위험 고지(§8) |
| D7 | **금액 기준은 트랙 그대로**: 라이트닝 = 원화(쿠팡 결제 금액), 온체인 = sats(UTXO 통째). 지정은 트랙과 직교하는 표시다 — 바꾸지 않는다 |
| D8 | 라이트닝 **인보이스 등록 마감 = 에스크로 수신 + 6시간**(기한 + 유예를 넘지 않게). 놓치면 기존 사유 `expired:no-invoice`(후원자 보증금 몰수). 공개·지정 둘 다 |
| D9 | 공개 오더북 보증금은 **운영 설정 유지 + 라이트닝 보증금 0%면 어드민 맨 위 경고**. 코드로 강제하지 않는다 |
| D10 | 온체인 지정 거래 최소 거래액 = **종결 수수료 × 20**(수수료 ≤ 5%). 공개 의뢰의 최소액(보증금 3% 근거, ≈ ×133)은 지정엔 근거가 없다 |
| D11 | 지정받은 후원자의 **거절 버튼은 없다**(이번). 말로 알리고 고객이 취소하거나 기한·만료로 닫힌다 |
| D12 | **트롤 피해 시간 줄이기는 라이트닝만.** 온체인은 창이 이미 짧다(펀딩 2h · 사전서명 · 계좌 1h · 송금 30m) |

### 기각한 대안 (다시 꺼내지 않게)
- **링크(비밀 코드) 공유:** 링크는 비밀이 아니다(전달·미리보기·기록에 남는다). 통신 수단이 있는데 카톡에 의존하는 것도 어색하다.
- **후원자 오퍼 게시판**(후원자가 "얼마 사겠다"를 올리고 고객이 집기): 같은 스팸 문제가 그대로 온다 — 수십·수백 개 중
  내 상대를 pubkey로 눈으로 찾을 수 없다.
- **공개 오더북에 보증금 없이 + 경고:** 합의한 상대보다 트롤이 먼저 찜한다(실제로 당한 것).
- **환불형 보증금 → 소액 선불 수수료(일반 인보이스):** 코드 복잡도를 크게 낮추지만 이번엔 보류.

## 3. 용어 · 사용자 흐름

- **고객** = 의뢰를 올리는 쪽, BTC를 **파는** 쪽(LN: 쿠팡 결제를 원하고 sats를 낸다 / 온체인: sats를 넘기고 원화를 받는다).
- **후원자** = BTC를 **사는** 쪽(원화를 보낸다). 두 트랙 모두 **의뢰는 고객이 만든다** — 지정 거래도 같다.
- **주소** = 그 기기의 nostr pubkey(npub). 공유해도 되는 값. 비밀키(nsec, 🔑 화면)와 섞이지 않게 화면을 분리한다.

```
후원자: 사주기 탭 › 지정 거래 › [내 주소] → npub·QR·확인 코드 → 카톡 등으로 고객에게 전달
고객:   의뢰하기 › 거래 방식 [지정 거래] → 상대 주소 붙여넣기/QR → 확인 코드 대조 ☑ → 위험 고지 ☑ → 등록
        (보증금 없음 — 바로 의뢰가 생긴다)
후원자: 사주기 탭 › "나를 지정한 거래"에 자동으로 뜬다(+웹 푸시) → 고객 확인 코드 대조 → 위험 고지 → [수락]
        (LN: 클레임 → 자동 승인 / 온체인: 받을 주소·수수료율 → 바로 bonded)
이후:   기존 흐름 그대로(에스크로·계좌·송금·확인·분쟁). 보증금 단계만 없다.
```

## 4. 프로토콜

### 4.1 새 kind · action · 태그
| 무엇 | 값 | 비고 |
|---|---|---|
| `DESIGNATED_ORDER_KIND` | **33839** (주소형, 우리 전용) | APP → 수신자 하나. `d=<orderId>:<수신자>`, `p=수신자`, `t=트랙 태그`, `expiration`=오더 보존. 내용 = NIP-44(APP→수신자) **오더 태그 배열 JSON** |
| `REQUEST_ACTIONS.DESIGNATED_ORDER_REQUEST` | `designated-order-request` | LN. 태그 `a·action·t·p=APP·expiration`만. 내용 = NIP-44(고객→APP) `{price, deadline, designatedSponsor}` |
| `REQUEST_ACTIONS.ONCHAIN_DESIGNATED_ORDER_REQUEST` | `onchain-designated-order-request` | 온체인. 태그 `a·action·t·p=APP·expiration(=의뢰 만료)`. 내용 = `{amountSat, customerXonly, reserveKrw?, refundAddress, designatedSponsor}` |
| 오더 태그 `designated-sponsor` | 지정 후원자 pubkey | 스냅샷 안에만 있다(공개 오더엔 없음). 있으면 NIP-69 태그·`source`는 싣지 않는다 |
| 오더 태그 `invoice-deadline` | unix초 | LN, `escrowed`에서 데몬이 찍는다(D8). 공개·지정 공통 |
| 클레임 | 기존 `claim`·`onchain-claim` 그대로 | 데몬이 `designated-sponsor`와 보낸 사람을 대조 |
| `PROTOCOL_VERSION` | **1 → 2** | 데몬·앱 같이 배포 |

### 4.2 스냅샷 방식 (핵심 재사용)
- 데몬: 지정 오더를 발행할 때 공개 `ORDER_KIND` 대신 **수신자마다**(고객 · 지정 후원자 · 운영자 전원, 중복 제거)
  `DESIGNATED_ORDER_KIND` 이벤트를 하나씩 낸다. 내용은 공개 오더와 **같은 태그 배열**(`lnOrderTags`/`onchainOrderTags`
  출력)을 NIP-44로 암호화한 것. `created_at`은 기존 단조 증가(`published_at`) 그대로.
- 앱: 받으면 ① `pubkey === APP` 확인 ② 내 키로 복호화 ③ 태그 배열 모양 확인 ④ **가짜 오더 이벤트**
  `{kind: ORDER_KIND, pubkey: APP, created_at, tags, content: '', id, sig: ''}`를 만들어 **기존 처리기에 그대로 넘긴다**
  (`handleAdminOrder`·`handleOrderEvent`·어드민 `onOrderEvent`). 파서(`parseLnOrderEvent`는 발행자만 본다)·저장소·IDB 보관·
  키 옮기기 되살리기·`noteOrderProtocol`이 손대지 않고 돈다.
- 공용 코드: `shared/src/designated.ts` — `DESIGNATED_ORDER_KIND`, `designatedOrderD()`, `sealOrderSnapshot(tags, recipient, sk)`,
  `openDesignatedOrder(event, mySk): Event | null`, `checkCode(pubkey)`, `parsePubkeyInput(text)`(npub·hex·`nostr:` 접두사).

### 4.3 무엇이 숨고 무엇이 보이나 (RISKS에도 적는다)
| 숨는 것(암호문) | 보이는 것(메타데이터) |
|---|---|
| 금액·기한·상대 지정·오더 상태 전부 | 지정 요청을 보낸 pubkey와 시각, APP이 어떤 pubkey들에게 스냅샷을 보냈는지(p 태그)와 시각 |
| | 이후 요청(클레임·계좌·송금…)의 존재·오더 id·보낸 pubkey — 공개 거래와 같다 |

pubkey는 브라우저마다 만든 앱 키라 실명과 무관하다. 그래도 "두 pubkey가 같은 때 스냅샷을 받았다"로 짝을 추정할 수는 있다 — 수용.

## 5. 데몬 — 라이트닝 (`daemon/src/ln/`)

- **DB(마이그레이션 v5·v6, `daemon/src/db/migrations.ts`):** `ln_orders`에 `invoice_deadline INTEGER`(P1), `designated_sponsor TEXT`(P3).
  `LnOrderRow`·`insertOrder()`(`store.ts`) 확장. 지정 의뢰는 `ln_drafts`(고객 보증금 대기)를 거치지 않는다.
- **보증금 필요 여부 한 곳에:** `sponsorDepositRequired(ctx, order)`(`flow.ts`) = `!order.designated_sponsor && 설정.sponsorDepositPct > 0`.
  지금 같은 판단이 4곳에 흩어져 있다 → 전부 이걸로: `handlers.ts` claim(106행), `watcher.ts` claimed 루프(104행),
  `flow.ts` `approveBlocker`(285행), `effects.ts` `sponsorDepositPending`(185행).
- **`handlers.ts`:** `designatedOrderRequest` 추가 — 내용 복호화(`nip44Decrypt`) → 가격·기한 검사는 `orderRequest`와 **같은 함수로 뽑아**
  공유 → `designatedSponsor` 64hex·자기 자신 금지 → `insertOrder({..., designatedSponsor})` 바로(초안·보증금 없음). 핸들러 표에 등록.
  `claim`: `order.designated_sponsor`가 있으면 보낸 사람이 그 pubkey가 아닐 때 `ignored('not-designated')`.
- **`watcher.ts`:** claimed 루프 — 지정이면 `autoApprove` 설정과 무관하게 승인(`approveBlocker===null`이면 `approve`).
- **`effects.ts` `buildOrderEvent`/`createOrderPublishExecutor`:** 지정이면 공개 이벤트 대신 수신자별 스냅샷(§4.2). 하나라도 못 내면 `retry`
  (주소형이라 다시 내도 같은 자리를 덮는다).
- **알림:** `notify.ts` — 지정 의뢰가 생기면 지정 후원자에게 웹 푸시 "지정 거래가 도착했습니다 — 수락하세요"(새 `NOTIFY` 문구).
  `store.ts` `insertOrder`의 운영자 DM은 지정이면 "새 지정 거래 — 라이트닝 N원".
- **어드민 상세**(`AdminLnOrderDetail`, `shared/src/admin-protocol.ts` + `effects.ts` `buildLnDetail`): `designatedSponsor`·`invoiceDeadline` 추가.

### 5.1 인보이스 등록 마감 (D8, P1 — 지정과 독립)
- `timing.ts`: `INVOICE_WINDOW_SEC = 6 * HOUR`.
- `flow.ts` `onEscrowAccepted`: `escrowed`로 바꿀 때 `invoice_deadline = min(now + INVOICE_WINDOW_SEC, deadline + DEADLINE_GRACE_SEC)`를 함께 찍는다.
- `watcher.ts` `closeAt`: `escrowed`면 `invoice_deadline ?? deadline + DEADLINE_GRACE_SEC`. 사유는 기존 `expiryReasonFor('escrowed') = 'expired:no-invoice'`
  그대로 — **FSM·닫기 사유 표 변경 없음**.
- 태그 `invoice-deadline`(`shared/src/ln/order.ts` `lnOrderTags`/`parseLnOrderEvent`, `Order.invoiceDeadline`).
- `notify-messages.ts` `sponsorShouldRegisterInvoice`: "… N 안에 등록해 주세요"(`durationText(INVOICE_WINDOW_SEC)`, 숫자 박지 않기).
- 유저 앱: 후원자 카드(`customer/src/ln/card-view.ts`·`LnOrderCard.tsx`)에 `escrowed`일 때 인보이스 마감 카운트다운.
- `timing-invariants.test.ts`: 마감이 기한 + 유예를 넘지 않는다는 성질은 `min`이 보장 — 대신 "창이 후원자 인보이스 최소 수명 검사와 충돌하지 않는다" 등 관계를 점검해 넣는다. `docs/LN-TRACK.md` 시간 표에 행 추가.

## 6. 데몬 — 온체인 (`daemon/src/onchain/`)

- **오더 모양:** `OnchainOrder.designatedSponsor?: string`(`shared/src/onchain/order.ts`, data JSON에 같이 저장 — 마이그레이션 없음).
  `onchainOrderTags`/`parseOnchainOrder`에 태그 추가, 지정이면 NIP-69 태그 생략. `isStoredOnchainOrder`에 `optional(isStr)`.
- **`bonds.ts` 리팩터(행동 그대로):** `onCustomerBond`의 몸통을 `listOc(ctx, {orderId, customer, info, bond?})`로,
  `onSponsorBond`의 몸통을 `bondOc(ctx, row, {sponsor, info, bond?})`로 뽑는다. 보증금 훅은 `bond`를 넣어 부르고, 지정 경로는 `bond` 없이 부른다.
- **`handlers.ts`:** `ocDesignatedOrderRequest` — 복호화 → 검사(`ocOrderRequest`와 공유하도록 검사 함수를 뽑는다: 주소·만료 상한·reserve·
  `acceptNewOrders`) → 최소액 = `TYPICAL_SETTLEMENT_VSIZE × halfHour × 20`(D10, 상수는 `deposit.ts` 옆 `DESIGNATED_MIN_FEE_MULTIPLE = 20`)
  → `listOc` 바로(후보·보증금 없음). `ocClaim`: 지정 오더면 지정 pubkey만, 검사(받을 주소·수수료율)는 그대로 → 후보·보증금 없이 `bondOc` 바로.
- **⚠️ `decide.ts` O-015 — 반드시:** 지금 `sponsorBondAlive`가 보증금 해시가 없으면 `undefined`(`watcher.ts:172`)이고, `decideBonded`는
  `undefined`면 **영원히 hold**한다 → 지정 거래가 펀딩 확정에서 멈춘다. `decideBonded`에서 `order.designatedSponsor`가 있으면 O-015 검사를
  건너뛴다(무담보 시세 옵션은 지정 거래의 수용된 위험 — §11). 테스트로 못박는다.
- **`bonds.ts` `applyOutcome`:** 몰수 경보(`forfeitUse`)를 **실제로 그 보증금이 있을 때만** 띄운다 — 지정 거래 종결마다 헛경보가 뜨지 않게.
- **알림:** 지정 의뢰가 `listed`로 생기면 지정 후원자에게 웹 푸시(`notify.ts`·`notify-messages.ts`). `insertOc` 운영자 DM은 "새 지정 거래 — 온체인 N sats".
- **발행:** `effects.ts` `createOcPublishExecutor` — 지정이면 수신자별 스냅샷(§4.2).
- 운영자 상세(`AdminOcOrderDetail.order`)에는 `designatedSponsor`가 오더 모양 그대로 실린다.

## 7. shared (`shared/src/`)
- `constants.ts`: 새 action 2개, `PROTOCOL_VERSION = 2`.
- `designated.ts`(새): §4.2의 함수들 + `checkCode(pubkey)` = `npub` 본문 앞 6 · 뒤 6(`npub1abcdef…uvwxyz`), `parsePubkeyInput()`.
- `ln/order.ts`: `LnOrderFields.designatedSponsor?`·`invoiceDeadline?`, 태그·파서, 지정이면 `nip69Tags` 생략. `isStoredLnOrder`에 `optional`.
- `types.ts` `Order`: `designatedSponsor?`, `invoiceDeadline?`.
- `onchain/requests.ts`: `isOnchainDesignatedOrderPayload` 가드. LN 요청 내용 가드 `isLnDesignatedOrderPayload`.
- `copy.ts`: 위험 고지 문구(트랙별, §8) — 생성·수락 화면이 같은 문구를 가져다 쓴다.
- `index.ts`·`core.ts`·트랙 index에 export.

## 8. 유저 앱 (`customer/src/`)

- **구독:** `nostr/subscribe.ts`에 `subscribeDesignatedOrders` — `{kinds:[33839], '#p':[나], '#t':[CLIENT_TAG], since}` → `openDesignatedOrder` →
  `buyer.handleAdminOrder` + `sponsor.handleAdminOrder`(`nostr/service.ts`). 온체인은 `onchain/nostr/service.ts`에 같은 구독(`CLIENT_TAG_ONCHAIN`) →
  `handleOrderEvent`.
- **발행:** `buyer/nostr/publish.ts` `publishDesignatedOrderRequest(order)`; `onchain/nostr/publish.ts` `publishOnchainDesignatedOrderRequest(params)`
  (`encryptToAdmin` 재사용).
- **키 옮기기 되살리기:** `nostr/own-requests.ts`(LN)·`onchain/nostr/own-requests.ts` — 새 action을 복호화해 기존과 같은 로컬 기록으로.
- **저장소:** `CustomerOrder.designatedSponsor?`(`buyer/types.ts` + `buyer/order-store.ts` 모양 확인). 온체인 `store.ts`:
  `listedOrders`에서 지정 제외 + `designatedToMe(myPubkey)`. LN `OrderBook.tsx`도 같은 분리.
- **화면:**
  - `MyAddressPanel`(새): npub · QR(`qrcode.react` — `InvoicePayBlock`과 같은 방식) · 확인 코드 · 복사. **사주기 탭 "지정 거래" 섹션의 버튼**으로 연다
    (🔑 nsec 화면과 분리 — 공유해도 되는 값과 절대 안 되는 값을 섞지 않는다).
  - `CounterpartyInput`(새): 붙여넣기 또는 QR 스캔(`sponsor/components/QrScanner.tsx` — `nostr:` 접두사 허용 추가) → 확인 코드 표시 →
    ☑ "상대 화면의 확인 코드와 같습니다" → ☑ 위험 고지. 자기 주소면 거절.
  - "거래 방식" 토글(공개 의뢰 · 보증금 / 지정 거래 · 보증금 없음): LN `buyer/components/OrderForm.tsx`·`ParsedOrdersSection.tsx`, 온체인 `onchain/components/OnchainOrderForm.tsx`.
  - "나를 지정한 거래" 섹션: LN `sponsor/components/OrderBook.tsx`, 온체인 `onchain/components/OnchainOrderBook.tsx` 맨 위 — 고객 확인 코드 · 금액 · 기한 · 고지 · [수락]
    (LN `OrderCard` 클레임 / 온체인 `OnchainBookCard`의 `ClaimForm`을 지정 변형으로). 상세 화면(`LnOrderDetail`·`OnchainOrderDetail`)의 "남에게 오더북 카드" 경로도 그대로 탄다.
  - 배지 "지정 거래": `ln/LnOrderCard.tsx`·`onchain/components/OnchainOrderCard.tsx`(+ `ln/card-view.ts`·`onchain/card-view.ts`에 플래그).
- **위험 고지 문구(초안):**
  > **지정 거래는 보증금이 없습니다.** 상대가 중간에 사라져도 제재할 방법이 없고, 가격이 정해진 뒤 시세가 불리하면
  > 상대가 빠질 수 있습니다. 라이트닝: 에스크로가 마감까지 묶였다가 돌아옵니다. 온체인: 환불 수수료는 내가 냅니다.
  > 믿을 수 있는 상대와만 하세요.

## 9. 어드민 (`admin/src/`)
- `daemon/feed.ts`: `{kinds:[33839], '#p':[운영자], '#t':[CLIENT_TAG, CLIENT_TAG_ONCHAIN], since: epoch}` → 서명기 `nip44Decrypt(APP_PUBKEY, …)` →
  가짜 이벤트 → 기존 `onOrderEvent`. (지정 오더는 공개 오더 구독에 안 잡히므로 이게 없으면 목록에서 빠진다.)
- 목록·상세 배지 "지정"(`components/OrderLists.tsx`·`LnOrderDetail.tsx`·`OnchainOrderDetail.tsx`).
- D9 경고: `App.tsx` 맨 위 배너에 "라이트닝 공개 보증금 0% — 공개 오더북이 무담보입니다"(`format.ts`에 순수 함수, `protocolWarning` 옆).

## 10. 문서
- `docs/PROTOCOL.md`: kind 33839, 새 action, 태그 2개, 구독 필터, §4.3 표, 운영자 DM 표(새 지정 거래).
- `docs/LN-TRACK.md`: 지정 거래(보증금 없음·자동 승인·지정 검사), `INVOICE_WINDOW_SEC` 행·부등식.
- `docs/ONCHAIN-TRACK.md`: 지정 거래(보증금 없음, O-015 건너뜀, 최소액 ×20), 코드 지도.
- `docs/RISKS.md`: R-5 갱신(인보이스 마감으로 상한 6h, 공개 보증금은 설정), **새 R-16 지정 거래 위험**(§11).
- `docs/ARCHITECTURE.md`: 유저 앱 흐름(내 주소·지정 거래), 운영자 DM 목록.
- `docs/ONCHAIN-SIGNET-DRILL.md`: 지정 거래 시나리오 추가. `CLAUDE.md` 문서 표에 이 플랜(진행 중) 한 줄.

## 11. 위험 · 한계 (RISKS R-16으로)
- **제재 없음:** 지정 상대가 사라지면 보증금이 없어 몰수할 게 없다. LN은 에스크로가 마감까지 묶였다 돌아오고(인보이스 마감 6h가 상한을 준다),
  온체인은 환불 수수료를 고객이 낸다. → 고지로 알린다(수용).
- **무담보 시세 옵션:** 가격 고정 뒤 원화를 보내기 전까지 시세가 불리하면 상대가 빠질 수 있다(온체인 O-015가 막던 것). → 수용·고지.
- **잘못된 주소:** 남의 npub를 붙여넣으면 그 사람이 무담보로 맡을 수 있다. → 확인 코드 대조 + 체크 필수.
- **메타데이터:** §4.3. → 수용.
- **지정 후원자가 앱을 안 열면** 의뢰는 기한·만료까지 남는다(스냅샷은 릴레이에 남고, 푸시를 켰으면 알림이 간다).

## 12. 단계 (커밋 단위 · 순서대로 · 각 단계 끝에 `pnpm verify` + 영향받는 빌드)

- [x] **P0 플랜 문서** — 이 문서를 `docs/PLAN-DESIGNATED-TRADE.md`로 커밋, `CLAUDE.md` 문서 표에 한 줄.
- [x] **P1 라이트닝 인보이스 마감(§5.1)** — 독립·작음. 테스트(`daemon/src/__tests__/ln-expiry.test.ts`): 에스크로 6h 뒤 미등록 →
  `expired:no-invoice`(에스크로 cancel·후원자 보증금 forfeit), 기한이 더 이르면 기한 + 유예, 태그 왕복, 카운트다운 표시.
- [x] **P2 shared 프로토콜(§4·§7)** — `designated.ts`, 태그·가드·action, `PROTOCOL_VERSION=2`. 테스트(`shared/src/__tests__/designated.test.ts`):
  봉인·개봉 왕복, APP 아닌 발행자·망가진 내용·남의 키 거절, 지정이면 NIP-69 태그 없음, `checkCode`·`parsePubkeyInput`, 저장소 모양 확인 통과.
- [x] **P3 데몬 라이트닝 지정(§5)** — 테스트(`ln-designated.test.ts`, `createLnHarness` 사용): 보증금 % 와 무관하게 초안 없이 바로 오더,
  지정 외 클레임 무시, 지정 클레임 → `autoApprove` 꺼져 있어도 승인·보증금 없음, **공개 `ORDER_KIND`가 하나도 안 나간다**,
  스냅샷이 고객·후원자·운영자에게 하나씩·복호화하면 `designated-sponsor`, 정상 흐름으로 `paid`까지, 고객 취소, 자기 지정 거절.
  (구현 메모: 발행은 `effects.ts` `buildOrderEvents` — 공개면 한 장, 지정이면 수신자별. 지정 후원자 푸시는 `notify.ts`
  `notifyDesignatedArrived`, 키 `ln:<id>:designated`. `openDesignatedOrder`는 데몬 테스트도 쓰므로 `core`에서도 export.)
- [x] **P4 데몬 온체인 지정(§6)** — `bonds.ts` 리팩터 먼저(기존 `oc-*` 테스트 그대로 통과 확인) → 지정 경로. 테스트(`oc-designated.test.ts`, `createOcHarness`):
  보증금 후보 없이 `listed`, 지정 외 클레임 거절, 지정 클레임 → `bonded`·에스크로 주소, **펀딩 컨펌 → `funded`(hold 아님)**,
  릴리스까지 e2e, 환불·취소에서 몰수 경보 없음, 최소액 ×20 경계.
  (구현 메모: `listOc`·`bondOc`(bonds.ts)가 공개·지정 공통 몸통, `bond?` 없으면 지정. 공개 의뢰 검사는 `orderGate`·`orderTermsProblem`
  (handlers.ts)으로 뽑아 순서 그대로 공유. 지정 클레임은 주소·수수료율 검사 뒤 바로 `bondOc`. 최소액 `designatedMinTradeSat`(deposit.ts).
  알림 `ONCHAIN_TIMER_NOTICES.designatedArrived` → `notifyOcDesignatedArrived`, 키 `oc:<id>:designated`. `OcPatch`는 `designatedSponsor`를 못 바꾼다.)
- [ ] **P5 유저 앱(§8)** — 구독·발행·되살리기·저장소·화면. 테스트(`customer/src/tests/designated.test.ts`): 스냅샷 → 저장소(LN·온체인),
  오더북에서 빠지고 "나를 지정한 거래"에만, 되살리기(새 action), card-view 플래그, `CounterpartyInput` 자기 주소 거절.
- [ ] **P6 어드민(§9)** — 피드 스냅샷·배지·0% 경고(`format.test.ts`).
- [ ] **P7 문서(§10)** — 트랙 문서·PROTOCOL·RISKS·드릴 런북.
- [ ] **P8 실검증·배포** — §13.

## 13. 검증
1. 자동: `pnpm verify`(타입·린트·테스트), `pnpm build:customer · build:admin · build:daemon · build:userscript`, CI(도커 이미지 포함).
2. 온체인 signet 드릴(`docs/ONCHAIN-SIGNET-DRILL.md`, `LNPAY_MODE=dev` 데몬 + `pnpm dev:customer` 두 브라우저): 후원자 "내 주소" → 고객 지정 등록 →
   후원자 화면에 자동 표시 → 수락 → 펀딩 → **가격 고정이 멈추지 않는다** → 사전서명 → 계좌 → 송금 → 릴리스. LN 지갑 없이 끝나는지 확인.
3. 라이트닝 mainnet 소액 드릴(운영 데몬, `pnpm preview:customer` 두 브라우저 — 크롬 일반 + 시크릿): 지정 등록 → 자동 표시 → 수락 → 에스크로(노드 밖 지갑) →
   인보이스 → 계좌 → 송금 → 확인. 제3 브라우저에서 그 의뢰가 **안 보이는지**. 어드민에 "지정" 배지로 보이는지.
4. 인보이스 마감: 테스트로 확인(실시간 6h 대기는 생략).

## 14. 배포
- `PROTOCOL_VERSION` 2 — **데몬 재빌드와 `pnpm ship`을 같이**(한쪽만이면 어드민 맨 위 경고가 뜬다).
- 마이그레이션 v5·v6은 데몬 부팅 때 자동.
- 운영: 어드민에서 라이트닝 공개 보증금(고객·후원자) 설정 — 0%면 경고가 남는다(D9).
- 유저: 새로고침(앱이 새 버전 배너로 안내). 유저스크립트는 이번에 안 바뀐다.

## 15. 다음에 (이번 범위 밖)
- 지정 후원자의 거절 버튼(D11), 후원자가 먼저 만드는 지정 거래, 환불형 → 선불 수수료 보증금, 지정 거래 상대 주소록(최근 상대).
