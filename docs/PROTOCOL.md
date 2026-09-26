# Nostr 프로토콜

앱 사이를 오가는 이벤트의 모양. 상태 전이 규칙은 트랙 문서([LN-TRACK.md](LN-TRACK.md) ·
[ONCHAIN-TRACK.md](ONCHAIN-TRACK.md)), 운영자 ↔ 데몬 명령 채널은 [ARCHITECTURE.md](ARCHITECTURE.md) §2에 있다.

**데몬(APP 키)이 모든 오더의 유일한 상태 소유자다.** 유저는 kind 1111로 요청만 하고, 데몬이 kind 30402를 발행·갱신한다.

```
유저 ──[kind 1111 요청, p=APP]──→ 릴레이 ──→ 데몬 ──[kind 30402 오더]──→ 릴레이 ──→ 유저 앱 (표시)
                                          └──[kind 1111 통지, p=유저]──→ 릴레이 ──→ 유저 앱
```

| 값 | |
|---|---|
| APP pubkey | `f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848` (`shared/src/constants.ts`). 개인키는 데몬만 |
| 오더 | kind **30402** (NIP-99 주소형, `d` = 오더 id) |
| 요청·통지 | kind **1111** (NIP-22) |
| 운영자 상태·상세 | kind 30078 (NIP-78) |
| 웹 푸시 구독 | kind 1111 `push-subscription` (암호문) |
| 트랙 태그 `t` | 라이트닝 `sajwo-tracker` · 온체인 `sajwo-tracker-onchain` · 어드민 어드민 태그. dev 빌드는 전부 `-dev` |

`sajwo-tracker`라는 이름은 옛 프로젝트명이다. 바꾸면 릴레이에 있는 모든 이벤트와 끊긴다.

## 1. 공통 규칙

- **APP이 서명한 30402만 오더다.** 누구나 30402를 낼 수 있으므로 파서가 발행자를 먼저 본다.
- **요청은 보낸 사람을 본다**(I-008·O-020). 고객 요청은 그 오더의 고객, 후원자 요청은 그 오더의 후원자, 통지는 APP.
- 요청은 `a` 태그(`30402:<APP>:<오더 id>`)로 오더를 가리킨다. 오더 id는 랜덤이다(쿠팡 주문번호를 쓰지 않는다).
- **모든 이벤트에 `expiration`(NIP-40)** — 릴레이 찌꺼기 방지. 예외 셋:
  `dispute-message`(분쟁 증거 보존), 운영자 경보 gift wrap kind 1059, `push-subscription`(계정 단위라 주문보다
  오래 산다).
- **`expiration`은 보존이지 거래 마감이 아니다**(DM-009). 릴레이는 지난 `expiration`을 가진 이벤트를 거절하고
  내주지도 않는다 — 거래 도중에 그러면 발행이 전부 실패한다.
- 암호문은 NIP-44. 계좌 정보는 **받는 사람(후원자)에게만** 암호화하고 공개 태그엔 솔트 커밋먼트만 둔다.

## 2. 오더 (kind 30402, APP)

### 라이트닝 (`shared/src/ln/order.ts`)

| 태그 | 뜻 |
|---|---|
| `d` · `t` · `status`(`active`/`sold`) · `state` | 식별·트랙·상태 |
| `price` `<원>` `KRW` | 쿠팡 결제 금액 |
| `customer` · `sponsor` | 역할 pubkey |
| `deadline` | **쿠팡 가상계좌 기한** — 카운트다운·오더북 필터 |
| `expiration` | 보존: `requested`면 기한, 진행 중이면 max(기한, 지금) + 30일, 종결이면 지금 + 7일 |
| `bolt11` | 에스크로 인보이스 (`verified`부터) |
| `payout` | 후원자가 받을 sats (`verified`부터) |
| `sponsor-invoice` | 후원자 지급처 인보이스 |
| `disbursed` | 지급 완료 |
| `customer-deposit-payment-hash` · `sponsor-deposit-payment-hash` | 받은 보증금 |
| `sponsor-deposit` = `pending` | 클레임됐지만 후원자 보증금 대기 — 양쪽 화면이 "후원자 찾는 중"으로 그린다 |
| `close-reason` | 종결 사유(`LnCloseReason`) |

`deadline`이 없는 옛 이벤트는 `expiration`을 기한으로 읽는다. 파싱 결과의 `Order.expiration`은 **기한**이고 보존은
`retainUntil`이다.

### 온체인 (`shared/src/onchain/order.ts`)

| 태그 | 뜻 |
|---|---|
| `d` · `t` · `status` · `state` · `network` | |
| `customer` · `sponsor` · `amount-sat` · `reserve-krw` | |
| `customer-xonly` · `sponsor-xonly` · `admin-xonly` · `escrow-address` · `timelock-blocks` | 세 키와 주소 — **유저 앱이 직접 파생해 대조한다** |
| `funding-deadline` · `presign-deadline` · `account-deadline` · `krw-deadline` · `cosign-deadline` | 데몬이 전이 때 찍은 마감 |
| `funding-outpoint` · `funding-confs` · `funded-at` · `price-krw` · `payout-sat` · `release-fee-sat` | T0 가격 고정 |
| `presigned-at` · `account-sent-at` · `remitted-at` · `account-disputed-at` · `disputed-at` | 시각 |
| `settlement-kind` · `settlement-fee-sat` · `decided-at` · `settlement-txid` · `settling-at` | 종결 결정 |
| `customer-deposit-payment-hash` · `sponsor-deposit-payment-hash` | 보증금 |
| `expiration` | `listed` 동안은 **의뢰 만료**(오더북에서 저절로 사라진다), 그 뒤엔 보존(진행 중 지금 + 70일, 종결 유예 7일) |

후원자의 받을 주소는 공개하지 않는다(요청 암호문 안에만 있다).

## 3. 요청 (kind 1111, 유저 → APP)

공통 태그: `a` · `action` · `t` · `p`=APP · `expiration`.

### 라이트닝

| action | 보내는 사람 | 추가 태그 / 내용 | 받는 상태 |
|---|---|---|---|
| `order-request` | 고객 | `price`, `deadline` | — |
| `claim` | 후원자 | | `requested` |
| `sponsor-invoice` | 후원자 | `bolt11` | `escrowed`·`invoiced`·`remitted`, 지급 전 `paid`·`sponsor_wins` |
| `account-info` | 고객 | `p`=후원자 추가, `commitment`. 내용 = 후원자에게 암호화한 `{accountInfo, salt}` | `invoiced`·`remitted` |
| `remit-request` | 후원자 | | `invoiced` (요청 시각 ≤ 기한 + 1h) |
| `payment-confirm` | 고객 | | `invoiced`·`remitted` |
| `cancel-request` | 고객 | | 초안·`requested`·`claimed`·`verified` |
| `dispute-message` | 양쪽 | `p`=자기 자신도. 내용 = APP에게 암호화한 채팅. **만료 없음** | 아무 때나 |
| `push-subscription` | 유저 | `a` 없음. 내용 = APP에게 암호화한 구독. **만료 없음** | — |
| `parsed-order` · `coupang-status` | 유저스크립트 → **자기 웹앱** | 자기 자신에게 암호화. 데몬은 안 본다 | — |

### 온체인

| action | 보내는 사람 | 추가 태그 / 내용 | 받는 상태 |
|---|---|---|---|
| `onchain-order-request` | 고객 | `amount-sat`, `customer-xonly`, `reserve-krw`?, `expiration`=의뢰 만료. 내용 = `{refundAddress}` | — |
| `onchain-claim` | 후원자 | `sponsor-xonly`. 내용 = `{payoutAddress, feerateSatPerVb}` | `listed` |
| `onchain-presig` | 후원자 | 내용 = `{psbt}` (릴리스, 후원자 서명) | `funded` |
| `account-info` | 고객 | 라이트닝과 같은 모양 | `presigned` |
| `remit-request` | 후원자 | | `presigned`(계좌 받음, 송금 마감 전) |
| `onchain-cosign` | 서명할 쪽 | `purpose` = `release`·`refund`·`dispute-customer`·`dispute-sponsor`·`rescue`. 내용 = `{psbt}` | `canActOnSignRequest` |
| `onchain-dispute` | 양쪽 | `stage`=`account-unusable`(후원자, 계좌 이의) | `remitted`, 이의는 `presigned` |
| `cancel-request` | 고객 | | 초안·`listed` |
| `dispute-message` | 양쪽 | 라이트닝과 같다 | |

데몬이 받는 action은 트랙별 핸들러 표(`createLnHandlers` · `createOcHandlers`)에 있는 것뿐이다. 나머지는
`ignored:no-route`로 닫힌다.

## 4. 통지 (kind 1111, APP → 유저)

`p`=받는 사람. 만료는 **그 통지가 쓸모 있는 동안**이다(쿠팡 기한이 아니다 — 기한 직후의 환불 통지가 거절됐었다).

| action | 트랙 | 뜻 |
|---|---|---|
| `deposit-required` | 둘 다 | `bolt11` — 보증금 인보이스. 만료 = 결제 기한 |
| `deposit-accepted` · `deposit-cancelled` · `deposit-settled` | 둘 다 | 보증금 받음 · 돌려줌 · 몰수 (7일 보존) |
| `claim-price-error` | 라이트닝 | 후원자 인보이스 거절·경고. 사유: `DECODE_FAILED`·`AMOUNT_MISMATCH`·`EXPIRES_TOO_SOON`·`EXPIRED_BEFORE_PAYOUT`·`LIQUIDITY_WARNING`·`ESCROW_ENDING_SOON` (이름은 옛것) |
| `reveal-request` | 라이트닝 | 운영자가 후원자에게 받은 계좌 공개를 요청 — 이게 와야 공개 버튼이 열린다 |
| `onchain-cosign` | 온체인 | 서명 요청 `{psbt}` (암호문). 릴리스는 후원자 서명이 든 PSBT, 그 밖은 **서명 없는** PSBT |
| `onchain-rejected` | 온체인 | `reason` — 요청을 처리할 수 없다. 없으면 거절이 유저에게 안 보인다 |
| `dispute-message` | 둘 다 | 운영자 답장(데몬이 APP 키로 대신 보낸다) |

## 5. 구독 필터

| 누가 | 필터 |
|---|---|
| 유저 앱 — 오더 | `kinds:[30402] authors:[APP] #t:[트랙 태그] since:VITE_NOSTR_SINCE` (트랙마다 하나) |
| 유저 앱 — 수신함 | `kinds:[1111] #p:[내 pubkey] #t:[트랙 태그] since:…` (역할 공용, 받은 뒤 action으로 분기) |
| 유저 앱 — 내가 보낸 요청 | `kinds:[1111] authors:[내 pubkey] #t:[트랙 태그] since:…` — 로컬 기록 되살리기 |
| 데몬 | `kinds:[1111] #p:[APP] since:커서−6h` — 5분마다 새로 연다 |
| 어드민 앱 | [ARCHITECTURE.md](ARCHITECTURE.md) §2 |

## 6. 이벤트 예시

```json
{
  "kind": 1111,
  "tags": [
    ["a", "30402:f1f3…a848:9b2e71c04d"],
    ["action", "order-request"],
    ["price", "32900", "KRW"],
    ["deadline", "1790400000"],
    ["t", "sajwo-tracker"],
    ["p", "f1f3…a848"],
    ["expiration", "1790941507"]
  ],
  "content": ""
}
```

```json
{
  "kind": 30402,
  "pubkey": "f1f3…a848",
  "tags": [
    ["d", "9b2e71c04d"], ["t", "sajwo-tracker"], ["status", "active"], ["state", "escrowed"],
    ["price", "32900", "KRW"], ["customer", "…"], ["sponsor", "…"],
    ["deadline", "1790400000"], ["expiration", "1792992000"],
    ["bolt11", "lnbc…"], ["payout", "24512"], ["sponsor-deposit-payment-hash", "…"]
  ],
  "content": ""
}
```
