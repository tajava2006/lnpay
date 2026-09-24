# 페어바이 Nostr Protocol Specification

Customer, Sponsor, Admin 세 앱이 공통으로 참조하는 Nostr 이벤트 프로토콜 명세.

## 시스템 개요

비트코인으로 상품을 결제하고 싶은 Customer와, 거래소 없이 BTC를 매수하고 싶은 Sponsor를
Nostr 릴레이를 통해 연결한다. Admin은 에스크로 서비스를 제공하여 거래의 안전성을 보장한다.

**Admin이 모든 오더의 유일한 상태 소유자**이다.
Customer와 Sponsor는 kind 1111로 요청만 하고, Admin이 kind 30402를 발행/갱신한다.
상태 전이 로직(FSM)은 오직 Admin에만 존재한다.

```
Customer ──[kind 1111 요청]──→ Relay ──→ Admin ──[kind 30402 발행/갱신]──→ Relay
                                                                          ↓
Sponsor ──[kind 1111 요청]──→ Relay ──→ Admin              Customer/Sponsor [표시만]
```

## 앱 Pubkey

```
f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848
```

이 pubkey는 페어바이 시스템 전체를 식별하는 용도이며, 개인키는 Admin(에스크로)만 보유한다.
유저(Customer, Sponsor)는 각자 랜덤 생성한 키페어를 사용한다.

## 릴레이 디스커버리 (NIP-65 Outbox Model)

### 원리

앱 pubkey의 **kind 10002** 이벤트에서 릴레이 목록을 파싱한다.

```
kind 10002 event tags:
  ['r', 'wss://relay1.com', 'read']
  ['r', 'wss://relay2.com', 'write']
  ['r', 'wss://relay3.com']          ← marker 없으면 read + write
```

### Outbox Model 적용 — 릴레이 선택 기준

이벤트의 성격에 따라 발행/구독할 릴레이가 결정된다. 세 가지 분류를 따른다:

#### ① 비즈니스 이벤트 (오더·요청) → 읽기 릴레이

Admin이 발행하는 오더(kind 30402)와 Customer/Sponsor가 발행하는 요청(kind 1111).

| 역할 | 동작 | 대상 릴레이 |
|------|------|------------|
| Admin | 오더 이벤트 **발행** | 앱의 **읽기** 릴레이 |
| Customer | 요청 이벤트 **발행** / 오더 **구독** | 앱의 **읽기** 릴레이 |
| Sponsor | 요청 이벤트 **발행** / 오더 **구독** | 앱의 **읽기** 릴레이 |
| Admin | 요청 이벤트 **구독** | 앱의 **읽기** 릴레이 |

#### ② Admin 전용 데이터 → 쓰기 릴레이

Admin만 발행하고 Admin만 읽는 비공개 설정 데이터 (kind 30078 NIP-78 LN 설정 등).

| 역할 | 동작 | 대상 릴레이 |
|------|------|------------|
| Admin | 설정 데이터 **발행** | 앱의 **쓰기** 릴레이 |
| Admin | 설정 데이터 **구독** | 앱의 **쓰기** 릴레이 |

#### ③ Admin → User 거래 알림 (NIP-17) → 읽기 릴레이

앱 밖에서 받는 알림이다. 유저가 자기 키를 nostr 클라이언트에 넣어두면,
거래가 자기 차례로 넘어올 때 그 클라이언트가 알림을 띄운다.

앱 내부 상태 전파와는 별개다 — 그건 kind 30402 오더 이벤트가 하고 있고,
이건 "앱을 안 보고 있을 때 부르는" 용도다.

| 역할 | 동작 | 대상 릴레이 |
|------|------|------------|
| Admin | kind 1059 gift wrap **발행** | 앱의 **읽기** 릴레이 |
| Customer/Sponsor (유저 키) | kind 0 + kind 10002 **발행** | 앱의 **읽기** 릴레이 |
| nostr 클라이언트 | kind 1059 (`#p`=내 pubkey) **구독** | 유저 10002의 **읽기** 릴레이 |

유저 kind 10002를 발행하는 이유: nostr 클라이언트가 "나에게 온 것"을 찾는
방식이 내 10002의 읽기 릴레이(인박스)를 구독하는 것이다. 이게 없으면
클라이언트는 자기 기본 릴레이만 뒤지고, 거기에 우리 릴레이가 없으면 알림을
영영 못 본다. kind 0은 클라이언트에서 이 키가 무엇인지 알아보게 하는 용도다.

발송 시점과 봉투 구성은 [알림 (NIP-17)](#알림-nip-17) 참조.

### 디스커버리 절차

1. Well-known 릴레이(`purplepag.es`, `relay.damus.io`, `nos.lol`)에 접속
2. `{ kinds: [10002], authors: [APP_PUBKEY] }` 필터로 조회
3. 태그에서 읽기/쓰기 릴레이 분리 추출:
   - `['r', url]` (marker 없음) → 읽기 + 쓰기 양쪽에 포함
   - `['r', url, 'read']` → 읽기 릴레이
   - `['r', url, 'write']` → 쓰기 릴레이
4. 10분마다 갱신 (릴레이 변경에 대응)

## 오더 이벤트 (kind 30402)

### Kind

**30402** (NIP-99 Classified Listing, addressable event)

### 발행자

**Admin만 발행한다** — 지금은 운영 PC의 **데몬**이 APP 키로 서명한다(PLAN-DAEMON, 2026-09-24~).
Customer/Sponsor는 kind 30402를 발행하지 않는다. 데몬 DB가 진실이고 이 이벤트는 그 투영이다 —
`created_at`은 오더마다 단조 증가한다(같은 초 두 발행에서 옛 상태가 남지 않게).

### Addressable Event 주소 체계

```
30402:<admin-pubkey>:<orderId>
```

Admin이 유일한 발행자이므로 모든 오더의 주소에 Admin pubkey가 들어간다.
같은 pubkey + kind + d-tag 조합의 이벤트는 최신 것만 유지된다.
오더 상태가 변경되면 동일 주소로 재발행하여 이전 이벤트를 대체한다.

### Tags

| Tag | Value | 설명 |
|-----|-------|------|
| `d` | orderId | NIP-33 addressable identifier |
| `status` | `active` \| `sold` | NIP-99 리스팅 상태 |
| `state` | OrderState | Admin FSM의 세부 상태 (아래 상태 머신 참조) |
| `customer` | pubkey | 주문 요청자(Customer)의 pubkey |
| `price` | 금액 (string), `KRW` | NIP-99 가격 태그. 입금해야 할 금액과 통화 |
| `deadline` | unix timestamp (seconds) | **쿠팡 가상계좌 기한** — 원화를 보낼 수 있는 마지막 시각. 카운트다운·오더북 필터·자동 종결의 기준 |
| `expiration` | unix timestamp (seconds) | NIP-40 **보존 기한**(`lnRetention`) — 거래 마감이 아니다. 아래 참조 |
| `t` | `sajwo-tracker` | 클라이언트 식별. 다른 30402 이벤트와 구분하기 위한 필수 태그 |
| `sponsor` | pubkey | 클레임한 후원자 (claimed 이후) |
| `bolt11` | 에스크로 홀드 인보이스 | verified 이후 — 고객이 결제한다 |
| `payout` | sats | 후원자가 받을 금액(승인 시 시세로 확정). 후원자 인보이스는 이 값과 **정확히** 같아야 한다 |
| `sponsor-invoice` | bolt11 | 검증을 통과한 지급처 (invoiced 이후) |
| `disbursed` | `true` | 지급 완료 |
| `customer-deposit-payment-hash` / `sponsor-deposit-payment-hash` | hex | 받은 보증금 |
| `close-reason` | `LnCloseReason` | 종결 사유 — 화면이 "왜 끝났는지"를 말한다(아래 표) |

> **거래 마감(`deadline`)과 보존(`expiration`)을 가른다** (PLAN-DAEMON §7 L-1, 2026-09-24).
> 예전엔 `expiration` 하나가 둘을 겸해서, 기한 직후의 송금 완료·판정·종결 발행이 릴레이에서
> 거절됐고(`invalid: event expired`, 2026-09-19 실측) 앱들은 진행 중 거래를 기한에 지웠다.
> 이제 보존은: `requested` = 기한(오더북에서 저절로 사라진다), 진행 중 = `max(기한, 지금) + 30일`,
> 종결 = 지금 + 7일. 앱은 **보존**으로 목록을 정리하고, 카운트다운은 **기한**으로 한다.
> `deadline` 태그가 없는 옛 이벤트는 `expiration`을 기한으로 읽는다.

### 상태 머신 (Admin 단일 FSM)

```
requested → claimed → verified → escrowed → invoiced ─→ remitted ─→ paid
    ↑          │                                │                ├──→ sponsor_wins
    └──────────┘ (클레임 되돌림)                └──→ paid        └──→ customer_wins

cancelled: requested, claimed, verified에서만 전이 가능
  (escrowed 이후는 상대방이 행동할 수 있으므로 일방 취소 불가)
expired:   requested ~ invoiced에서, 쿠팡 기한(escrowed·invoiced는 + 유예 1시간)이 지나면 데몬이
admin_closed: escrowed, invoiced에서만. 운영자 명령
터미널: paid, cancelled, sponsor_wins, customer_wins, admin_closed, expired
```

> `escrowed → paid` 지름길은 **2026-09-18에 제거**했다. 후원자 인보이스를 에스크로
> 이후에 받게 되면서 `escrowed`는 지급 대상이 아직 없는 상태가 됐고, 거기서
> settle하면 BTC를 받아놓고 보낼 곳이 없다(불변조건 I-010). 같은 지름길이
> `invoiced → paid`로 옮겨갔다 — 지급 대상이 확보된 뒤다.
> 근거 = [docs/DESIGN-LATE-INVOICE.md](docs/DESIGN-LATE-INVOICE.md)

| 상태 | 의미 | NIP-99 status |
|------|------|---------------|
| `requested` | Customer가 사줘 요청을 보냄, Admin이 오더 생성 | `active` |
| `claimed` | Sponsor가 클레임, Admin이 수락 | `active` |
| `verified` | Admin이 시세로 금액(`payout`) 확정 + hold invoice 발행 | `active` |
| `escrowed` | Customer가 hold invoice 결제, BTC 에스크로 중 | `active` |
| `invoiced` | Sponsor가 지급받을 인보이스 등록 + Admin 검증 완료. **이 상태부터 Customer가 계좌 정보를 발행한다** | `active` |
| `remitted` | Sponsor가 KRW 송금했다고 주장 | `active` |
| `paid` | 거래 완료 — Customer가 입금 컨펌 (최종) | `sold` |
| `cancelled` | 취소 — 거래 불발 (최종) | `sold` |
| `sponsor_wins` | 분쟁: 후원자 승리 — Admin이 송금 증거 확인, hold invoice settle (최종) | `sold` |
| `customer_wins` | 분쟁: 고객 승리 — 송금 증거 불충분, hold invoice 환불 (최종) | `sold` |
| `admin_closed` | **어드민 강제 종결** — 방치된 거래를 끊고 에스크로 환불 (최종) | `sold` |
| `expired` | **기한 만료** — 쿠팡 기한이 지나 원화가 갈 수 없어 데몬이 닫았다 (최종). 처리는 사유별(아래) | `sold` |

상태 전이 규칙:

| from | to | 트리거 |
|------|-----|--------|
| requested | claimed | Sponsor claim 수신 (기한이 1시간 넘게 남았을 때만) |
| requested | cancelled | Customer 취소 |
| claimed | requested | 후원자 보증금 15분 미납, 또는 운영자 되돌림 |
| claimed | verified | 데몬이 금액 확정 + 에스크로 인보이스를 **실제로 만든 뒤** (자동 승인 또는 운영자) |
| claimed | cancelled | Customer 취소 |
| verified | escrowed | Customer hold invoice 결제 |
| verified | cancelled | Customer 취소, 또는 결제 기한(≤24h, 기한 30분 전까지) 넘김 |
| requested ~ invoiced | expired | 쿠팡 기한 경과 (escrowed·invoiced는 + 유예 1시간), 또는 에스크로 HTLC 만기가 기한보다 먼저 옴 |
| escrowed | invoiced | Sponsor `sponsor-invoice` 수신 + 금액·소유자·만료 검증 통과 |
| invoiced | remitted | Sponsor가 KRW 송금 완료 주장 |
| invoiced | paid | Customer가 직접 입금 컨펌 (Sponsor 시그널 없이) |
| remitted | paid | Customer가 입금 컨펌 — **settle이 성공한 뒤에** `paid`가 발행된다(DM-003) |
| remitted | sponsor_wins | 분쟁: Admin이 송금 증거 확인 → hold invoice settle → Sponsor에게 BTC 전달 |
| remitted | customer_wins | 분쟁: 증거 불충분 → hold invoice 환불 → Customer BTC 반환 |
| escrowed \| invoiced | admin_closed | 어드민이 방치된 거래를 끊음 → hold invoice 취소(환불) |

> `admin_closed`를 `cancelled`와 따로 둔 이유: 취소는 거래 시작 전의 정상 이탈이고
> 고객이 스스로 한다. 이건 **에스크로가 잡힌 뒤** 아무도 움직이지 않아 어드민이
> 손으로 끊는 것이라 성격이 다르다. 그리고 `escrowed → cancelled`를 여는 순간
> T-003(선취적 취소)이 부활하므로, 전이 맵에 예외를 내는 대신 별도 상태를 만들었다.
>
> 그대로 두면 hold invoice가 CLTV 타임아웃까지 유동성을 붙들고 **같은 채널의 다른
> 결제까지 막는다**(2026-09-19 실측).

> `escrowed` 이후 상태에서는 `cancelled`로 전이할 수 없다.
> 에스크로가 잡힌 시점부터 Sponsor가 행동할 수 있으므로, Customer 일방의 취소를 허용하면
> 어뷰징 벡터가 생긴다 (상세: [THREAT-MODEL.md](THREAT-MODEL.md) §T-002).
> Sponsor가 미행동 시 기한(+ 유예)에 데몬이 `expired`로 닫고 에스크로를 돌려준다(예전엔 CLTV 타임아웃까지
> `escrowed`로 방치됐다). `remitted`는 반드시 판정(paid / sponsor_wins / customer_wins)으로만 종결된다 —
> 원화가 갔다는 주장이 있으면 기한으로 자르지 않는다. 대신 에스크로 HTLC 만기가 가까우면 데몬이 **먼저
> settle해 두고**(비대칭 손실 원칙, 만기 36블록 전) 운영자를 부른다.

### 종결 사유 → 에스크로·보증금 처리

사유가 곧 처리다(`shared/src/ln/outcomes.ts`의 `CLOSE_RULES`, `Record`라 사유를 추가하면 빌드가 깨진다).
종결 상태 하나에 정반대 처리가 섞여 있어서다 — `cancelled`에 보증금을 돌려주는 경우와 가져가는 경우가 있다.
종결 이벤트의 `close-reason` 태그가 이 값이다.

| 사유 | 종결 | 에스크로 | 고객 보증금 | 후원자 보증금 |
|---|---|---|---|---|
| `paid` | paid | settle → 지급 | 환불 | 환불 |
| `sponsor_wins` | sponsor_wins | settle → 지급 | 환불 | 환불 |
| `customer_wins` | customer_wins | 환불 | 환불 | **몰수** |
| `admin_closed` | admin_closed | 환불 | 환불 | 환불 |
| `cancel:customer` (후원자 전) | cancelled | — | 환불 | — |
| `cancel:customer-after-claim` | cancelled | 환불 | **몰수** | 환불 |
| `cancel:unpaid-escrow` | cancelled | 무효 | **몰수** | 환불 |
| `expired:no-sponsor` · `expired:not-approved` | expired | — | 환불 | 환불 |
| `expired:unpaid-escrow` | expired | 무효 | **몰수** | 환불 |
| `expired:no-invoice` (escrowed) | expired | 환불 | 환불 | **몰수** (§14 D4) |
| `expired:no-remit` (invoiced) | expired | 환불 | 환불 | 환불 (계좌가 나간 뒤라 원화가 오갔을 수 있다) |

고객 보증금은 에스크로가 잡히는 순간(`escrowed`) 돌려준다 — 실결제가 담보를 대신한다.

> `state` 태그는 다중 문자이므로 릴레이 인덱싱이 보장되지 않는다.
> 필터링은 클라이언트 사이드에서 수행한다.
> `status` 태그(`active`/`sold`)는 NIP-99 호환을 위해 유지한다.

### Content

빈 문자열 (`""`). 모든 정보는 태그로 전달된다.

계좌 정보(bankName, accountNumber 등)는 Customer가 `account-info` kind 1111로
Sponsor에게 NIP-44 암호화하여 전달한다 (아래 요청 이벤트 섹션 참조).
Lightning invoice 등 비트코인 결제 정보는 태그로 전달한다.

### 이벤트 예시

```json
{
  "kind": 30402,
  "pubkey": "f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848",
  "created_at": 1770372000,
  "tags": [
    ["d", "123456789"],
    ["status", "active"],
    ["state", "requested"],
    ["customer", "<customer-pubkey>"],
    ["price", "22950", "KRW"],
    ["t", "sajwo-tracker"],
    ["deadline", "1770458336"],
    ["expiration", "1770458336"]
  ],
  "content": "",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

## 요청 이벤트 (kind 1111)

### Kind

**1111** (NIP-22 Comment)

### 발행자

Customer 또는 Sponsor. 대부분은 Admin에게 **요청**하는 형태이며,
Admin이 요청을 검토하고 타당하면 kind 30402를 갱신한다.
예외: `parsed-order`와 `account-info`는 Admin 방향이 아닌 Customer 자체 알림/Sponsor 전달용이다.

### 공통 태그

| Tag | Value | 설명 |
|-----|-------|------|
| `a` | `30402:<admin-pubkey>:<orderId>` | 대상 오더 참조 (addressable event 주소) |
| `action` | 요청 종류 | 아래 표 참조 |
| `t` | `sajwo-tracker` | 클라이언트 식별 |
| `p` | Admin pubkey | Admin이 `#p` 필터로 수신 |
| `expiration` | unix timestamp (seconds) | 요청의 **보존** — 지금 + 7일(`lnRequestExpiration`). 오더 기한이 아니다(아래) |

### 요청 종류 (action 태그 값)

| action | 발행자 | 설명 | 추가 태그 |
|--------|--------|------|-----------|
| `order-request` | Customer | 사줘 요청 신청 | `['price', 금액, 'KRW']`, `['deadline', 쿠팡 기한]` (지금 + 1시간 ~ 7일) |
| `claim` | Sponsor | 클레임 신청 | — (인보이스는 에스크로 뒤 `sponsor-invoice`로) |
| `sponsor-invoice` | Sponsor | 지급받을 인보이스 | `['bolt11', invoice]` — escrowed에서 처음, invoiced·remitted, **지급 전이면 paid·sponsor_wins에서도** 교체 |
| `payment-confirm` | Customer | 입금 완료 신고 | — |
| `cancel-request` | Customer | 주문 취소 신고 | — |
| `account-info` | Customer | Sponsor에게 계좌정보 전달 | `['p', sponsorPubkey]`, `['commitment', sha256(salt+plaintext)]` |
| `remit-request` | Sponsor | 원화 송금 완료 통보 | — |
| `dispute-message` | Customer / Sponsor / Admin | 분쟁 채팅 메시지 (NIP-44 암호화) | `['p', recipientPubkey]`, content=NIP-44 JSON |
| `parsed-order` | 유저스크립트 | 쿠팡 주문 자동 감지 알림 | `['p', ownPubkey]`, content=NIP-44 자기암호화 |
| `coupang-status` | 유저스크립트 | 쿠팡 입금/취소 감지 알림 | `['p', ownPubkey]`, content=NIP-44 자기암호화. **a-tag 없음** |
| `claim-price-error` | Admin | 후원자 인보이스 거절·경고 | `['reason', DECODE_FAILED\|AMOUNT_MISMATCH\|EXPIRES_TOO_SOON\|EXPIRED_BEFORE_PAYOUT\|LIQUIDITY_WARNING\|ESCROW_ENDING_SOON]`, `['expected-sats', n]` |
| `deposit-required` | Admin | 보증금 hold invoice 전달 | `['p', recipientPubkey]`, `['bolt11', invoice]` |
| `deposit-accepted` / `-cancelled` / `-settled` | Admin | 보증금 상태 변경 알림 | `['p', recipientPubkey]` |
| `reveal-request` | Admin | 분쟁 중재용 계좌정보 공개 요청 | `['p', sponsorPubkey]` |
| `push-subscription` | Customer / Sponsor | Web Push 구독 등록 | `['p', APP_PUBKEY]`, content=NIP-44 암호화. **a-tag·expiration 없음** |

#### `push-subscription`에 a-tag도 expiration도 없는 이유

구독은 **계정 단위**이고 주문보다 오래 산다. 주문에 묶거나 만료를 달면 그 주문이
끝나는 순간 다음 거래의 알림이 조용히 끊긴다 — 실패가 눈에 안 보이는 종류라 특히 나쁘다.

내용을 NIP-44로 암호화하는 것도 필수다. 엔드포인트와 `auth` 시크릿이 공개되면
**아무나 그 유저에게 푸시를 쏠 수 있다.** VAPID는 발신자를 제한하는 장치일 뿐,
엔드포인트 자체가 비밀이어야 성립한다.

#### `account-info`의 커밋먼트는 솔티드다

`commitment = sha256(salt ‖ JSON.stringify(accountInfo))`이고, 32바이트 랜덤 salt는
**암호문 안에** 들어가 후원자만 안다. 분쟁 시 후원자가 계좌정보와 salt를 함께 공개하면
Admin이 대조한다.

솔트가 없으면 원상 공간이 너무 작아(은행 ~20개, 계좌번호는 은행별 고정 포맷, 예금주 2~3자)
공개 커밋먼트만으로 계좌번호가 브루트포스된다 — 같은 이벤트의 NIP-44 암호화가 무의미해진다.
솔트 도입 이전 기록은 무솔트로 검증한다(커밋먼트는 발행 시점에 고정된 값이라 안전하다).

#### `coupang-status`는 a-tag이 없다

유저스크립트는 쿠팡 페이지에서 돌기 때문에 웹앱이 만든 **랜덤 orderId를 알 수 없다.**
그래서 쿠팡 주문번호만 자기암호화해 자기 자신에게 보내고, 웹앱이 로컬 매핑
(`CustomerOrder.coupangOrderId`, 발행되지 않는 필드)으로 찾아 진짜
`payment-confirm` / `cancel-request`를 발행한다.

이 설계에는 부수 효과가 하나 있다 — **유저스크립트가 APP_PUBKEY를 전혀 참조하지 않게 된다.**
2026-09-03 키 교체 후 설치본이 옛 키를 계속 써서 어드민 `#p` 필터에 안 걸리는 바람에
자동 입금감지가 6주간 조용히 죽어 있었는데, 그 고장이 구조적으로 불가능해진다.
대신 자동 컨펌이 "쿠팡 페이지에서 즉시"가 아니라 "웹앱을 다음에 열 때" 나간다.

#### `reveal-request`가 없으면 공개 버튼이 열리지 않는다

계좌정보 공개는 분쟁 대응 수단인데, 예전에는 `remitted` 상태면 후원자 화면에 버튼이
그냥 보였다. `remitted`는 "원화 송금했어요" 직후의 **정상 상태**라, 흐름의 일부인 줄 알고
계좌를 Admin에게 그냥 보내는 일이 실제로 생겼다. FSM에 '분쟁 중' 상태가 없으므로
Admin의 명시적 요청을 신호로 쓴다.

### a-tag 참조 규칙

모든 kind 1111 요청은 대상 오더의 a-tag(`30402:<admin-pubkey>:<orderId>`)를 포함한다.
**예외: `parsed-order`와 `coupang-status`는 a-tag이 없다** — 유저스크립트가 발행하는데
sajwo orderId를 모르기 때문이다(위 참조).
최초 `order-request` 시점에는 아직 해당 kind 30402 이벤트가 릴레이에 존재하지 않지만,
addressable event의 주소(`30402:<admin-pubkey>:<orderId>`)는 구성 요소가 모두 알려져 있으므로 a-tag을 넣을 수 있다.
Nostr 릴레이는 a-tag 대상 이벤트의 존재 여부를 검증하지 않는다.

### 요청의 만료 = 보존 7일

요청 이벤트의 `expiration`은 **지금 + 7일**이다(`lnRequestExpiration`). 예전엔 오더 기한을 그대로 썼는데,
그러면 **기한 직후의 송금 완료·입금 확인이 릴레이에서 거절된다** — 그 요청들이 제일 중요한 순간이다.
7일이면 데몬이 잠시 꺼져 있어도 복귀해서 받는다(데몬은 이벤트 id로 한 번만 처리한다). 오래된 요청을
판단하지 않는 건 데몬 몫이다 — 상태 전이 검사와, 송금 완료는 `created_at ≤ 기한 + 유예`로 거른다.

**예외: `dispute-message`는 만료 태그를 포함하지 않는다.**
dispute-message는 메인 구독(kind 1111)으로 수신되지만, localStorage가 아닌 IndexedDB(messages 스토어)에만 저장된다.
다른 요청 이벤트(order-request, claim 등)는 localStorage에 저장되어 만료 시 삭제해야 데이터 비대화를 방지하지만,
dispute-message는 localStorage를 거치지 않으므로 이 문제가 없다. 분쟁 채팅은 판정 이후에도 참조될 수 있는 법적 증거 기록이므로 영구 보존한다.
릴레이가 자체 정책으로 삭제해도 IDB가 영구보존을 담당하므로 무방하다.

### Content

대부분 빈 문자열 (`""`). 예외:
- `account-info`: NIP-44 암호화된 계좌정보 JSON
- `dispute-message`: NIP-44 암호화된 채팅 메시지 JSON

#### account-info 이벤트 상세

Customer가 Sponsor에게 무통장입금 계좌정보를 암호화 전달한다.
상태 전이를 유발하지 않는다.

- **수동 주문**: `verified` 상태에서 사용자가 수동으로 발행
- **파싱 주문**: `escrowed` 상태에서 웹앱이 자동 발행 (hold invoice 결제 확인 후)

- **content**: `NIP-44.encrypt(JSON.stringify({bankName, accountNumber, holderName}), customer_privkey, sponsor_pubkey)`
- **`['p', sponsorPubkey]`**: Sponsor가 `#p` 필터로 수신 (Admin의 `['p', APP_PUBKEY]`와 함께)
- **`['commitment', sha256(plaintext)]`**: 분쟁 시 검증용 해시 커밋먼트

**복호화**: Sponsor만 가능 (자기 개인키 + Customer 공개키).
**분쟁 검증**: Sponsor가 평문 공개 → Admin이 `sha256(평문) == commitment` 태그 대조 → 부인·조작 불가.

### 이벤트 예시: order-request

```json
{
  "kind": 1111,
  "pubkey": "<customer-pubkey>",
  "created_at": 1770372000,
  "tags": [
    ["a", "30402:f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848:123456789"],
    ["action", "order-request"],
    ["price", "22950", "KRW"],
    ["t", "sajwo-tracker"],
    ["p", "f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848"],
    ["expiration", "1770458336"]
  ],
  "content": "",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

### 이벤트 예시: claim

```json
{
  "kind": 1111,
  "pubkey": "<sponsor-pubkey>",
  "created_at": 1770372100,
  "tags": [
    ["a", "30402:f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848:123456789"],
    ["action", "claim"],
    ["bolt11", "lnbc229500n1p..."],
    ["t", "sajwo-tracker"],
    ["p", "f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848"],
    ["expiration", "1770458336"]
  ],
  "content": "",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

#### parsed-order 이벤트 상세

유저스크립트(Tampermonkey)가 쿠팡 무통장입금 주문을 감지하여 Customer 웹앱에 알린다.
Admin에게 전달되지 않으며, 사용자가 웹앱에서 사줘 요청 여부를 직접 결정한다.

- **`['p', ownPubkey]`**: 자기 pubkey — Customer 웹앱만 `#p` 필터로 수신
- **`['action', 'parsed-order']`**: 액션 식별
- **content**: `JSON.stringify({coupangOrderId, productName, price, bankName, accountNumber, depositor, expirationDate})`
- **a-tag 없음**: 아직 Admin 오더가 생성되지 않은 상태이므로 a-tag을 포함하지 않는다

```json
{
  "kind": 1111,
  "pubkey": "<customer-pubkey>",
  "created_at": 1770372000,
  "tags": [
    ["p", "<customer-pubkey>"],
    ["action", "parsed-order"],
    ["t", "sajwo-tracker"],
    ["expiration", "1770458336"]
  ],
  "content": "{\"coupangOrderId\":\"123456789\",\"productName\":\"상품명\",\"price\":22950,\"bankName\":\"국민은행\",\"accountNumber\":\"123-456-789\",\"depositor\":\"쿠팡\",\"expirationDate\":1770458336000}",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

#### dispute-message 이벤트 상세

분쟁 상태(`remitted`)에서 Admin이 Customer/Sponsor 양쪽과 개별 채팅으로 증거를 검토하기 위한 메시지다.
Admin, Customer, Sponsor 모두 발행할 수 있다. NIP-44로 암호화하여 당사자만 읽을 수 있다.

- **발행자**: Customer, Sponsor, Admin 모두 가능
- **수신 경로**: 메인 구독(kind 1111)으로 수신. 다른 요청 이벤트와 동일한 필터로 도달한다.
- **저장**: localStorage가 아닌 IndexedDB `messages` 스토어에만 저장 (데이터 비대화 방지 + 증거 영구보존)
- **리액티브 UI**: 디테일 페이지 진입 시 on-demand 릴레이 구독 + 인메모리 chat-store로 실시간 렌더링
- **만료 태그**: 없음 (증거 보존 목적, 위의 "만료 태그 통일" 예외 참조)

**태그 구조:**

| Tag | Value | 설명 |
|-----|-------|------|
| `a` | `30402:<admin-pubkey>:<orderId>` | 대상 오더 참조 |
| `action` | `dispute-message` | 액션 식별 |
| `t` | `sajwo-tracker` | 클라이언트 식별 |
| `p` | recipientPubkey, senderPubkey | 수신자 + 발신자 (dual p-tag, 릴레이 `#p` 필터 최적화) |

**Content (NIP-44 암호화 JSON):**

```typescript
// 일반 텍스트 메시지
{ "type": "text", "content": "메시지 내용" }

// 계좌정보 공개 (Sponsor가 분쟁 시 증거 제출)
{ "type": "account-reveal", "accountInfo": { "bankName": "...", "accountNumber": "...", "holderName": "..." } }
```

**암호화/복호화:**
- Customer/Sponsor → Admin: `nip44Encrypt(plaintext, senderSk, APP_PUBKEY)` / Admin은 `signer.nip44Decrypt(senderPubkey, ciphertext)`
- Admin → Customer/Sponsor: `signer.nip44Encrypt(recipientPubkey, plaintext)` / 상대방은 `nip44Decrypt(ciphertext, sk, APP_PUBKEY)`
- Admin이 자기 발신 에코를 복호화할 때: `signer.nip44Decrypt(recipientPubkey, ciphertext)` (NIP-44 conversation key는 대칭)

**커밋먼트 검증 (account-reveal):**
Sponsor가 `account-reveal` 메시지를 보내면 Admin이 자동 검증한다:
1. IDB에서 해당 오더의 `account-info` 요청 이벤트 조회
2. `commitment` 태그의 해시값 추출
3. `sha256(JSON.stringify(revealedAccountInfo))` === commitment 비교
4. UI에 검증 결과 배지 표시 (녹색 체크: 일치, 경고: 불일치)

```json
{
  "kind": 1111,
  "pubkey": "<sender-pubkey>",
  "created_at": 1770372200,
  "tags": [
    ["a", "30402:f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848:123456789"],
    ["action", "dispute-message"],
    ["t", "sajwo-tracker"],
    ["p", "<recipient-pubkey>"],
    ["p", "<sender-pubkey>"]
  ],
  "content": "<NIP-44 encrypted JSON>",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

## 구독 필터

> **2026-09-12 통합 이후**: 고객앱과 후원자앱이 한 앱이 되면서 구독도 한 벌로 합쳐졌다.
> 두 앱이 쓰던 필터가 원래 문자 그대로 같았기 때문에 합치는 데 변경이 필요 없었다.
> 아래 두 필터가 통합 앱이 여는 전부다.

### 통합 앱 — 오더 (양쪽 역할 공용)

```json
{
  "kinds": [30402],
  "authors": ["f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848"],
  "#t": ["sajwo-tracker"]
}
```

Admin이 발행한 **모든** 오더를 받는다. 서버에서 역할별로 좁힐 수 없다 —
오더북은 남의 주문까지 필요하고, `customer`/`sponsor`는 다중 문자 태그라
릴레이 인덱싱이 보장되지 않는다. 그래서 클라이언트에서 가른다:

- 고객 역할: `customer` 태그가 내 pubkey인 것만
- 후원자 역할: 전부 (오더북), `state`로 활성/종료 구분

### 통합 앱 — 수신함 (양쪽 역할 공용)

```json
{
  "kinds": [1111],
  "#p": ["<my-own-pubkey>"],
  "#t": ["sajwo-tracker"]
}
```

나에게 오는 kind 1111 전부. `action` 태그로 분기한다. 고객 역할 핸들러가 먼저 보고,
소화하지 못하면 후원자 역할 핸들러로 넘긴다.

받는 것: `parsed-order`·`coupang-status`(유저스크립트 → 자기 자신),
`account-info`(고객 → 후원자), `deposit-*`·`claim-price-error`·`reveal-request`(Admin → 나),
`dispute-message`.

### Admin — 요청 수신

```json
{
  "kinds": [1111],
  "#p": ["f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848"],
  "#t": ["sajwo-tracker"]
}
```

모든 Customer/Sponsor의 요청을 `#p` 필터로 수신한다.
`action` 태그로 요청 종류를 분류한다.

### Admin — 자기 오더 동기화

```json
{
  "kinds": [30402],
  "authors": ["f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848"],
  "#t": ["sajwo-tracker"]
}
```

새 탭/재시작 시 자기가 발행한 오더를 릴레이에서 복원하기 위한 구독.

## 거래 흐름

### 전체 흐름

```
Customer                    Admin (에스크로)              Sponsor
   │                          │                           │
   │  ① order-request 발행     │                           │
   │  (kind 1111)              │                           │
   │ ────────────────────────→│                           │
   │                          │  ② 오더 생성               │
   │                          │  (kind 30402,              │
   │                          │   state=requested)         │
   │                          │ ────────────────→ Relay    │
   │                          │                     │      │
   │  ③ 오더 상태 수신          │                     │      │
   │ ←────────────────────────┼─────────────────────┘      │
   │                          │                            │
   │                          │                     ┌──────│
   │                          │    ④ 오더북에서 확인  │      │
   │                          │                     └─────→│
   │                          │                            │
   │                          │  ⑤ claim 발행               │
   │                          │  (kind 1111 + bolt11)       │
   │                          │ ←──────────────────────────│
   │                          │                            │
   │                          │  ⑥ 유동성 검증 (probing)    │
   │                          │                            │
   │                          │  ⑦ 오더 갱신                │
   │                          │  (state=claimed→verified)   │
   │                          │ ────────────────→ Relay    │
   │                          │                            │
   │  ... hold invoice, KRW 입금, settle ...                │
   │                          │                            │
   │                          │  ⑧ 오더 갱신 (state=paid)   │
   │                          │ ────────────────→ Relay    │
```

### 클레임 흐름 (Sponsor → Admin)

Sponsor의 클레임이 Customer에 직접 도달하지 않는다.
Admin이 중간에서 Lightning 인바운드 유동성을 검증한 후에만 상태를 전이한다.

```
Sponsor                    Admin (에스크로)
   │                          │
   │  ① 클레임 이벤트 발행     │
   │  (kind 1111, action=claim,│
   │   bolt11=invoice)         │
   │ ────────────────────────→│
   │                          │  ② 인바운드 유동성 검증
   │                          │  (해당 금액의 BTC를
   │                          │   수신할 수 있는가?)
   │                          │
   │  [유동성 부족 시]          │
   │                          │  → state=rejected로 갱신
   │                          │
   │  [유동성 충분 시]          │
   │                          │  → state=claimed→verified
   │                          │  → kind 30402 갱신 발행
```

이 검증이 필요한 이유: Lightning Network는 채널 기반이므로 수신 측에 충분한
인바운드 유동성(inbound liquidity)이 없으면 BTC를 받을 수 없다.
유동성 없는 Sponsor가 클레임해봤자 거래가 완료될 수 없으므로 사전에 차단한다.

### Lightning 유동성 검증 방법

Sponsor가 클레임 시 주문 금액에 해당하는 **Lightning invoice**를 생성하여 제출한다.
Admin은 이 invoice에 대해 **probing**(경로 탐색)을 수행하여 유동성을 검증한다.

```
Sponsor                          Admin
   │                               │
   │  ① invoice 생성 + 클레임 발행   │
   │  (kind 1111, bolt11 태그)       │
   │ ─────────────────────────────→│
   │                               │  ② invoice 디코딩
   │                               │  ③ probing (랜덤 해시 결제 시도)
   │                               │     - 목적지 도달 → 유동성 충분
   │                               │     - 중간 실패 → 유동성 부족
   │                               │
   │  ④ kind 30402 상태 갱신         │
   │  (verified 또는 rejected)       │
   │ ←─────────────────────────────│
```

#### Probing 원리

아무도 프리이미지를 모르는 랜덤 payment hash로 결제를 시도한다.
각 홉의 실제 유동성을 테스트하면서 경로를 따라 진행되며:

- **목적지 도달 후 실패** (`INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS`): 경로+유동성 모두 충분
- **중간 홉에서 실패** (`TEMPORARY_CHANNEL_FAILURE` 등): 유동성 부족

프리이미지가 존재하지 않으므로 실제 결제가 성립되지 않고, 수수료도 발생하지 않는다.

LND(`SendPaymentV2` + 랜덤 hash)와 CLN(`getroute` + `sendpay`) 모두 probing을 지원한다.
구현체 독립적인 `LightningProber` 인터페이스로 추상화하여 어느 노드든 대응 가능하게 한다.

#### Hold Invoice는 Probing에 부적합

Hold invoice의 settle/cancel 권한은 **수신자**(Sponsor)에게 있어,
송신자(Admin)가 일방적으로 취소할 수 없다 (CLTV timeout 대기 필요).
따라서 "보내고 바로 취소"하는 테스트 용도로는 사용할 수 없다.

### 에스크로 (Hold Invoice)

유동성 검증이 통과한 후, 거래 보증을 위해 Admin이 Customer의 BTC를 **에스크로로 보관**한다.
Sponsor가 KRW를 먼저 입금하는 구조이므로, 입금 후 Customer가 BTC를 보내지 않을 위험을 차단한다.

이때는 **hold invoice**를 사용한다. Probing에서 hold invoice가 부적합했던 이유가
"수신자가 settle 권한을 가짐"이었는데, 에스크로에서는 **수신자(Admin)가 settle 권한을
가져야 하므로** 정확히 적합하다.

```
Customer                         Admin                          Sponsor
   │                               │                               │
   │  ① Admin이 hold invoice 생성   │                               │
   │ ←─────────────────────────────│                               │
   │                               │                               │
   │  ② Customer가 hold invoice 결제│                               │
   │ ─────────────────────────────→│  (BTC가 HTLC에 잠김)           │
   │                               │  → state=escrowed 갱신         │
   │                               │                               │
   │  ③ 계좌 정보 전달 (NIP-44)     │                               │
   │ ──────────────────────────────────────────────────────────────→│
   │                               │                               │
   │                               │  ④ Sponsor가 KRW 무통장입금    │
   │                               │       (쿠팡 계좌로)            │
   │                               │                               │
   │                               │  ⑤ KRW 입금 컨펌               │
   │                               │                               │
   │                               │  ⑥ Admin이 hold invoice settle │
   │                               │     → BTC 수령                 │
   │                               │  → state=paid 갱신             │
   │                               │                               │
   │                               │  ⑦ Admin이 Sponsor에게 BTC 전송│
   │                               │ ─────────────────────────────→│
   │                               │                               │
   │  [문제 발생 시]                 │                               │
   │                               │  settle 안 함 → CLTV timeout   │
   │ ←── BTC 자동 환불 ────────────│  후 Customer에게 BTC 반환      │
   │                               │  (앱 상태는 escrowed 유지)      │
```

#### Hold Invoice 원리 (에스크로 용도)

1. **Admin이 invoice 생성**: 프리이미지(preimage)를 알고 있는 건 Admin뿐
2. **Customer가 결제**: HTLC가 경로를 따라 전파되어 BTC가 잠김
3. **Admin이 settle**: 프리이미지를 공개하여 BTC를 수령
4. **Admin이 settle 안 함**: CLTV timeout 후 HTLC가 풀려 Customer에게 자동 환불

| 상황 | Admin 행동 | 결과 |
|------|-----------|------|
| KRW 입금 컨펌됨 | settle | Admin이 BTC 수령 → Sponsor에게 전송 |
| 거래 취소/분쟁 | settle 안 함 | CLTV timeout 후 Customer에게 환불 |

#### Probing vs 에스크로: Hold Invoice 적합성 비교

| 단계 | 방향 | 필요한 제어권 | 방법 | Hold Invoice 적합? |
|------|------|-------------|------|-------------------|
| 유동성 검증 | Admin → Sponsor | 송신자(Admin)가 취소 | Probing (랜덤 hash) | **부적합** (수신자 제어) |
| 에스크로 수금 | Customer → Admin | 수신자(Admin)가 settle | Hold invoice | **적합** (수신자 제어) |

## 스팸/DoS 차단

익명 시스템이므로 양측 모두에서 스팸 공격이 가능하다. 각각 다른 메커니즘으로 차단한다.

### Customer 스팸 차단: Fidelity Bond

Customer가 가짜 주문을 대량 발행하여 오더북을 오염시키는 공격을 차단한다.

**방법**: 사줘 요청 발행 시 주문 금액의 일부(10~100%)를 **hold invoice로 선납**한다.
어차피 Customer가 지불해야 할 BTC이므로 추가 비용이 아니라 지불 시점의 차이일 뿐이다.
BTC가 없는 스패머는 원천 차단된다.

```
Customer                         Admin
   │                               │
   │  ① order-request 발행          │
   │  (kind 1111)                   │
   │ ─────────────────────────────→│
   │                               │
   │  ② fidelity bond hold invoice │
   │ ←─────────────────────────────│
   │                               │
   │  ③ hold invoice 결제           │
   │ ─────────────────────────────→│  (BTC 잠김, 오더북에 노출)
   │                               │  → state=requested 갱신
   │                               │
   │     ... 클레이머 등장 + 유동성 검증 통과 ...
   │                               │
   │  ④ fidelity bond cancel       │
   │ ←─── BTC 즉시 반환 ───────────│
   │                               │
   │  ⑤ 정확한 환율로 본 hold invoice│
   │ ←─────────────────────────────│
   │                               │
   │  ⑥ 본 hold invoice 결제       │
   │ ─────────────────────────────→│  (에스크로 시작)
   │                               │  → state=escrowed 갱신
```

#### BTC 가격 변동 대응

Fidelity bond 시점과 실제 거래 시점의 BTC/KRW 환율이 다를 수 있다.
따라서 fidelity bond는 정확한 금액이 아닌 **보증 목적의 소액**으로 받고,
클레이머 확정 + 유동성 검증 통과 시점에 fidelity bond를 **cancel**(즉시 환불)한 뒤
해당 시점의 정확한 환율로 본 hold invoice를 새로 발행한다.

- LND: `CancelInvoice(payment_hash)` → HTLC 즉시 해제, Customer에게 BTC 반환
- CLN: hold invoice 플러그인의 cancel → 동일
- Cancel 시 라우팅 수수료 포함 전액이 Customer에게 환불된다 (HTLC가 settle되지 않으면 중간 노드도 수수료를 가져가지 못함)

> **취소-재발행 윈도우**: Fidelity bond cancel과 본 hold invoice 결제 사이에
> Customer가 이탈할 수 있다. 하지만 이 시점에서 Sponsor는 아직 KRW를 보내지 않았으므로
> Sponsor 손해는 없고, Customer만 거래 기회를 잃는다.

### Sponsor 스팸 차단: Fidelity Bond (보증금)

Sponsor가 클레임만 하고 KRW를 입금하지 않는 트롤링을 차단한다.

**방법**: Sponsor의 claim 수신 시 주문 금액의 일부를 **hold invoice로 보증금** 수령한다.
보증금을 결제해야 Admin이 verified 상태로 승인할 수 있으므로, BTC 없는 스패머는 원천 차단된다.

```
Sponsor                          Admin
   │                               │
   │  ① claim 발행                 │
   │  (kind 1111 + bolt11)         │
   │ ─────────────────────────────→│
   │                               │
   │  ② deposit hold invoice       │
   │ ←─────────────────────────────│  (deposit-required)
   │                               │
   │  ③ hold invoice 결제          │
   │ ─────────────────────────────→│  (deposit-accepted → 승인 가능)
   │                               │
   │     ... 거래 정상 완료 (paid) ...
   │                               │
   │  ④ deposit cancel (환불)      │
   │ ←─── BTC 즉시 반환 ───────────│
```

**보증금 생명주기**:
- `paid` / `sponsor_wins` → cancel (전액 환불): 정상 거래 또는 Sponsor 승리
- `customer_wins` → settle (몰수): Sponsor 트롤링 인정
- 기타 → Admin 수동 판단

#### Lightning 노드 블랙리스트 (보류, 추가 방어)

보증금으로 1차 스팸 게이트가 확보되었으므로 블랙리스트는 보류.
규모 확장 시 추가 방어 레이어로 도입을 검토한다.

**핵심 인사이트**: Nostr pubkey는 무료로 무한 생성 가능하지만,
Lightning 노드는 채널에 실제 BTC를 lock해야 운영 가능하다.
따라서 **Nostr pubkey가 아닌 Lightning 노드 pubkey**로 Sponsor를 식별한다.

```
Sponsor의 invoice → invoice 디코딩 → destination node pubkey 추출
                                      → 이것이 Sponsor의 실제 식별자
```

## 유저 키 관리

- Customer/Sponsor 모두 최초 실행 시 `generateSecretKey()`로 랜덤 키페어 생성
- Secret key는 `number[]`로 변환하여 localStorage에 보관
- 키 관리 로직은 `@sajwo-tracker/shared`의 `ensureKeypair(storage)`로 통일
- NIP-07/NIP-46 등 기존 Nostr 로그인 시스템은 사용하지 않음 (Customer/Sponsor용)
- Admin은 NIP-46 원격 서명을 사용하여 `.env` 의존성 없이 동작
- 유저스크립트 키 공유: Customer 웹앱에서 nsec(bech32) 표시 → Tampermonkey에 1회 입력 → GM_storage 보관
- 일반 유저 대상이므로 Nostr의 존재를 노출하지 않음
  (예외: 알림 설정 화면 — 알림을 받으려면 키를 nostr 클라이언트에 넣어야 하므로
  거기서만 드러난다. 순전히 선택이라 안 쓰면 끝까지 안 보인다)

## 알림

Admin이 유저에게 "당신 차례입니다"를 보낸다. 앱을 열고 있지 않아도 알림이 뜬다.

**통로가 둘이고 문구는 한 벌이다.** 같은 사건을 Web Push와 NIP-17이 각각 나르되
문구 표는 `admin/src/nostr/notify-messages.ts` 한 곳에서 나온다 — 두 벌로 두면
한쪽만 고치는 일이 반드시 생긴다.

| | Web Push | NIP-17 DM |
|---|---|---|
| 유저가 할 일 | 브라우저 "허용" 1회 | nostr 클라이언트에 키 넣기 |
| 설치 | 없음 | 클라이언트 앱 |
| 브라우저 닫아도 | 안드로이드 ✅ / PC는 프로세스 생존 시 | 클라이언트가 받음 |
| iOS | 홈 화면 추가 시 ✅ | ❌ (지원 클라이언트 없음) |
| 위치 | 1순위 | **현재 UI 미노출** |

NIP-17은 2026-09-17부터 **완전히 껐다**(안내·발송·신원 발행 전부). Web Push가
크롬·브레이브·파이어폭스·안드로이드까지 커버하게 되면서 "앱 하나 더 설치"를
권할 이유가 없어졌고, 안내 없이 계속 발송하면 아무도 안 여는 gift wrap이
릴레이에 쌓이기만 한다(계정 단위라 만료 태그도 없다).

스위치는 `shared/src/constants.ts`의 `NOSTR_DM_NOTIFICATIONS` 하나다. 이걸 켜면
어드민 발송·유저 신원 발행(kind 0/10002)·🔔 모달 안내가 함께 살아난다.
화면과 발송을 따로 끄면 반드시 어긋나기 때문에 한 스위치로 묶었다.

### 발송 시점

상태 전이 표는 `admin/src/nostr/notify-triggers.ts`가 진실이다.

| 전이 후 상태 | 고객 | 후원자 |
|---|---|---|
| `verified` | 결제 요청 | — |
| `escrowed` | — | **인보이스 등록 요청** |
| `invoiced` | 계좌 전달 요청 | — |
| `remitted` | **입금 확인·컨펌 요청** | — |
| `paid` | 완료 | 완료 |
| `cancelled` | 취소됨 | 취소됨 |
| `sponsor_wins` / `customer_wins` | 판정 결과 | 판정 결과 |
| `requested` / `claimed` | — | — |

상태 전이가 아닌 발송이 둘 있다.

`account-info` 요청 수신 시 후원자에게 "원화를 보낼 수 있다"를 알린다. `escrowed` 안에서 일어나는 변화라 상태로는
안 잡히지만, 후원자에게 필요한 알림은 사실상 이것 하나뿐이다.

`push-subscription` 등록 시 **푸시로만** 확인 알림을 한 번 보낸다. 유저가 "켜졌나"를
확인할 방법이 달리 없고, macOS/윈도우가 첫 알림 자리에서 OS 권한 창을 띄워 그 알림을
묻어버리기 때문이다 — 그 자리를 실제 거래 알림이 맞으면 통째로 증발한다.
**처음 보는 엔드포인트일 때만** 보낸다. 어드민은 재부팅마다 같은 등록 이벤트를
릴레이에서 다시 받으므로, 저장할 때마다 보내면 새로고침할 때마다 유저에게 날아간다.

`remitted`는 후원자가 이미 원화를 보내놓고 고객의 컨펌을 기다리는 상태라
가장 시급하다. 만료 임박 알림은 넣지 않았다 — 주문별 발송 이력이 기기 간
동기화돼야 중복 발송을 막을 수 있는데, 그 상태를 만들 만큼의 값은 아니다.

### 봉투 구성

| 겹 | kind | 서명자 | 비고 |
|---|---|---|---|
| rumor | 14 | 없음 | `pubkey`=APP_PUBKEY, `id`만 계산 |
| seal | 13 | Admin | NIP-44로 rumor 암호화. **번커 필요** |
| wrap | 1059 | 임시키 | `['p', recipient]`. 발신자 은닉 |

Admin은 NIP-46 원격 서명이라 로컬에 개인키가 없다. nostr-tools의 `nip17.wrapEvent`는
개인키를 요구해서 쓸 수 없지만, `nip59.createWrap(seal, recipientPubkey)`은 스스로
임시키를 만들기 때문에 그대로 쓸 수 있다. 따라서 손으로 만드는 건 seal 한 겹뿐이고,
그것도 번커의 `nip44Encrypt` + `signEvent` 두 호출로 끝난다.

seal/wrap의 `created_at`은 NIP-59 요구대로 최대 이틀 전으로 흩뿌린다.

### 내용 정책

금액·계좌·상대 신원은 넣지 않는다. NIP-17이 내용을 가려주지만 수신자가 키를
어디에 로그인해 뒀는지는 알 수 없다. "무슨 일이 생겼고 어디로 가면 되는지"만
싣고 나머지는 앱에서 보게 한다.

## 온체인 트랙 (2-of-3 taproot) — 별도 FSM

> **집행자는 데몬이다**(PLAN-DAEMON P4, 2026-09-24). 이 절의 "어드민"은 운영 PC의 데몬(APP 키)을 뜻한다.
> 어드민 키는 주문마다 **시드에서 파생**한다(`HMAC-SHA256(seed, "lnpay/onchain-admin/v1/<orderId>/<n>")`) —
> 키 저장소·릴레이 백업·"백업이 확인돼야 주소를 낸다"가 없어졌다. 판정·계좌 이의·구조는 운영자가 명령으로
> 내린다(`oc.rule` · `oc.account-dispute` · `oc.rescue` · `oc.resend`), 나머지는 데몬 워처가 자동이다.
> 보증금(LN 홀드 인보이스)은 라이트닝과 같은 기계(`daemon/src/hold`)로 만들고 정리한다.

> 라이트닝 트랙과 **완전히 분리된 트랙**이다. 설계 근거와 공격 분석은
> [docs/PLAN-ONCHAIN-TRACK.md](docs/PLAN-ONCHAIN-TRACK.md)가 진실이고, 여기에는
> **프로토콜로 굳은 것**만 적는다.
>
> 구현 진행: P0~P5 · P7 · P8(구현 감사 반영) ✅ / P6은 코드 몫까지 ✅, 실제 signet
> 드릴이 남았다. 태그·action의 전체 표는 PLAN §5.1·§5.2가 진실이고, 여기에는
> **어기면 돈이 새는 규칙**만 옮긴다(아래 "이벤트 규칙").

### 태그 분리 — `sajwo-tracker-onchain`

```ts
CLIENT_TAG_ONCHAIN = import.meta.env.DEV
  ? 'sajwo-tracker-onchain-dev' : 'sajwo-tracker-onchain'
```

**같은 `CLIENT_TAG`를 쓰면 배포 사고가 난다.** 이미 배포된 클라이언트가
`{ kinds:[30402], authors:[APP_PUBKEY], '#t':[CLIENT_TAG] }`로 돌고 있어서, 온체인
오더를 같은 태그로 발행하면 구버전 앱이 그걸 라이트닝 오더로 렌더링한다
(`payoutSat`이 없어 "0 sat을 등록하세요"가 뜬다 — 2026-09-19 실측).

`track` 태그로 클라이언트에서 거르는 방법은 **모든 클라이언트가 업데이트된 뒤에야**
첫 오더를 발행할 수 있다. 정적 PWA라 캐시된 구버전이 언제까지 남는지 알 수 없다.

`내 거래` 탭은 두 태그를 **동시에 구독**하고 `track` 필드로 가른다.

### 상태 머신 (라이트닝과 별도)

```
listed → bonded → funded → presigned → remitted → settling → released
            ↑        │          │          │          │
            └────────┴──────────┘          ↓          ├→ refunded
            (리오그 복귀)             disputed ───────→├→ sponsor_wins
                                                       └→ customer_wins
bonded · funded · presigned ──→ refunding ──→ settling → refunded

cancelled: listed, bonded에서만 (funded 이후 불가)
refunding: 환불이 **결정**됐다. 여기서는 앞으로 가지 않는다
swept:     어드민이 만들지 않는다 — **체인에서 관측**한다 (펀딩 이후 어느 상태에서든)
터미널:    released, refunded, sponsor_wins, customer_wins, cancelled, swept
```

**멤풀 관측은 상태가 아니다.** "펀딩 tx가 멤풀에 있음"을 상태로 뒀다가 없앴다 —
그 상태의 정보 내용은 "0-conf를 봤다" 하나뿐인데 우리는 0-conf로 아무 결정도
내리지 않는다. 펀딩 판정은 **"마감 안에 이 주소로 약정 금액이 N컨펌 됐는가"**
한 줄이고, 중간에 고객이 RBF로 수수료를 올리든 자기 주소로 빼가든 보지 않는다.
화면에는 "멤풀에서 보임 · 컨펌 대기"를 힌트로만 띄운다.
(근거: [PLAN §4.1c](docs/PLAN-ONCHAIN-TRACK.md))

| 상태 | 의미 |
|------|------|
| `listed` | 의뢰 등록됨 (고객 LN 보증금 결제 완료). 오더북 노출 |
| `bonded` | 후원자 보증금 accepted = **클레임 성립**. 세 키 확정 → 에스크로 주소 발행. **고객이 마감 안에 펀딩을 컨펌시켜야 하는 구간** |
| `funded` | 펀딩 N컨펌. **KRW 가격 확정(T0)**. 후원자 사전서명 대기 |
| `presigned` | 사전서명 검증됨. 고객이 **15분** 내 계좌 공개 → 그때부터 송금 창 30분 |
| `remitted` | 후원자가 원화 송금 주장. 고객이 은행 확인 후 cosign해야 한다 |
| `disputed` | 어드민 판정 대기. **고객 동의 없이 진입한다** |
| `refunding` | **환불이 결정됐다**(마감 초과 · 최저가 미달 · 보증금 만료 · 계좌 이의). 고객의 환불 서명 대기. 늦은 사전서명·계좌·송금 주장·릴리스는 **전부 거절** |
| `settling` | 종결 tx 브로드캐스트됨. `settlementKind`가 어느 종결인지 지정 |
| `released` | `{C,S}` 릴리스 컨펌 — 정상 완료 (최종) |
| `refunded` | `{A,C}` 환불 컨펌 — 분쟁 아닌 사유 (최종) |
| `sponsor_wins` / `customer_wins` | 분쟁 판정 (최종) |
| `cancelled` | 펀딩 전 취소 — 온체인 tx 없음 (최종) |
| `swept` | 타임락으로 고객이 일방 회수 (어드민 고장). 어드민은 관측만 (최종) |

**클레임은 상태가 아니다.** 보증금 결제가 곧 클레임이다 — 인보이스 발행~결제
대기는 사이드 스토어에 둔다. 무료 예약 상태를 만들면 **한 푼도 안 내고 오더를
묶어두는 그리핑**이 열린다(라이트닝 트랙에는 그 구멍이 남아 있다).

### 이 트랙에서만 다른 것

| | 라이트닝 | 온체인 |
|---|---|---|
| 어드민 역할 | **수탁자** (hold invoice settle/cancel) | **공동 서명자** — 자금을 만지지 않는다 |
| 순서 | 후원자 매칭 → 고객 에스크로 | 후원자 매칭 → **주소 생성** → 고객 펀딩 |
| 종결 | 상태 발행 한 번 | **tx 브로드캐스트 + 컨펌** (그래서 `settling`이 있다) |
| 취소 | `escrowed` 전까지 자유 | **펀딩 tx 부재를 확인해야** 취소된다 |
| 환불 | 어드민 단독 (hold invoice cancel) | `{A,C}` — **고객이 먼저, 어드민이 마지막에** 서명한다. 받는 곳은 **고객이 의뢰 때 낸 환불 주소** |
| 수수료 | 고객이 `payout × 1.005`로 전부 | **한 쪽에 하나씩** (고객=펀딩 tx, 후원자=릴리스 tx) |

### 종결 사유 → 보증금 처리

**전이만 보고 판단하면 어드민이 돈을 정반대로 처리한다.** `refunded` 하나에
보증금 처리가 반대인 사례가 섞여 있어서, 사유(`settlementKind`)가 진실이다.
코드에서는 `OUTCOME_RULES`가 이 표이고 `Record`로 못박혀 있다.

| 사유 | 후원자 보증금 | 고객 보증금 |
|---|---|---|
| `release` | 환불 | 환불 |
| `refund:reserve` (시세 < 최저가) | 환불 | 환불 |
| `refund:sponsor-timeout` | **몰수** | 환불 |
| `refund:customer-late` (계좌 미공개) | 환불 | **몰수** |
| `refund:bond-expired` | (LN 만료로 이미 환불) | 환불 |
| `refund:account-disputed` (계좌 이의 판정 대기) | **보류** | **보류** — 판정이 사유를 `customer-late`/`sponsor-timeout`으로 바꿀 때 집행 |
| `sponsor_win` | 환불 | **몰수** |
| `customer_win` | **몰수** | 환불 |
| `cancel:customer` / `cancel:expired` | — | 환불 |
| `cancel:no-funding` (마감까지 미컨펌) | 환불 | **몰수** |
| `swept` | LN 만료 환불 | LN 만료 환불 |

몰수금의 쓰임이 갈린다: **분쟁이면 전액 중재료**, 타임아웃이면 50%를 피해자에게
수동 충당(운영 재량 — 권리가 아니므로 UI에서 약속하지 않는다).

**보증금은 결정 시점에 처리한다** — 종결 tx 컨펌 때가 아니다. 환불 tx는 고객 서명이
있어야 나가므로, 컨펌 때 몰수하면 `refund:customer-late`처럼 **몰수당할 쪽이 서명을
미뤄** 보증금 HTLC 만료를 기다릴 수 있다. 터미널에서 한 번 더 불리지만 멱등이다.

### 마감

| 상태 | 마감 | 초과 시 |
|---|---|---|
| `listed` | 의뢰 만료 (**최대 7일**) | `cancelled` |
| `bonded` | **6시간 (컨펌까지)** | `cancelled`, 고객 보증금 몰수 |
| `funded` | T0+15분 | `refunding` (`refund:sponsor-timeout`) |
| `presigned` (고객) | 계좌 공개 = +15분 | `refunding` (`refund:customer-late`) |
| `presigned` (후원자) | 송금 = **계좌 공개 +30분** | `refunding` (`refund:sponsor-timeout` · 이의가 있었으면 `refund:account-disputed`) |
| `remitted` | 24시간 | **`disputed` 강제 전이** (동의 불필요) |
| `disputed` | **하드 마감 없음** (에스컬레이션만) | 자동 해소는 어느 방향이든 탈취다. 판정 예산 24h 뒤엔 몰수를 못 할 수 있다 |
| `refunding` | **없음** (6시간마다 서명 재요청) | 고객 자기 돈이고 고객만 서명할 수 있다. 최후는 타임락 |
| `settling` | 24시간 | CPFP 안내. 멤풀에서 사라지면 같은 바이트 재브로드캐스트 |

총 옵션 창은 **T0+60분을 넘지 않는다** — 앞 두 마감이 T0에 묶여 있고, 후원자
마감만 계좌 공개를 기준으로 센다(고객 지연이 후원자를 치지 않게).

타임락은 **8064블록(≈8주)** 상대 타임락(CSV)이다. 펀딩 컨펌부터 세므로 원화가
흐르는 시점에는 언제나 만기 전량이 남아 있다.

### 게이트 (코드에 단언으로 박힌 것)

| 규칙 | 코드 |
|---|---|
| 계좌 정보는 `presigned`·`remitted`에서만 발행 | `canSendAccountInfoOnchain()` |
| **릴리스는 절대 자동화하지 않는다** — 고객 수동 확인만 | `canAutoRelease()` (타입까지 `false`) |
| `bonded` 이후 취소는 **"주소에 컨펌 UTXO 없음" 확인** 필수 (모르면 거부) | `canCancelOnchain()` |
| 가격 유효창 = `remitted` + 24시간. 넘기면 경고 + 명시적 우회만 | `isPriceStale()` |
| 주소는 클라이언트가 **직접 파생해 대조** | `verifyEscrowAddress()` |
| 세 키가 하나라도 겹치면 주소를 만들지 않는다 | `assertEscrowKeys()` |
| 서명 요청은 **FSM이 허락할 때만** — 화면과 어드민 핸들러가 같은 함수 | `canActOnSignRequest()` |
| 유저는 서명 요청을 **자기 기록으로 다시 만들어 txid 대조** 후, 다시 만든 tx에 서명 | `checkSignRequest()` → `buildCosignature()` |
| 어드민은 **마지막에** 서명하고, raw tx(outbox)와 `settling`을 **한 트랜잭션에** 적은 뒤 브로드캐스트(효과) | 데몬 `onchain/flow.ts` `ocCosign()` · `enterSettling()` |
| 후원자는 원화 전에 **펀딩을 체인에서 직접** 확인 (outpoint · 주소 · 금액 · 컨펌) | `checkFundingOnChain()` |
| 후원자 feerate 경계: `1 ≤ r ≤ max(100, 5×fastest)`, 수수료 ≤ 금액의 20% | `releaseFeerateProblem()` |
| 최저가는 신선한 시세보다 3% 이상 아래 | `reserveProblem()` |

### 이벤트 규칙 (어기면 돈이 새는 것)

- **발신자를 본다.** 어드민 통지(`deposit-required` · `onchain-cosign` 서명 요청 ·
  `onchain-rejected` 등)는 `APP_PUBKEY`만, 계좌(`account-info`)는 **그 오더의 고객**만,
  요청은 그 역할의 pubkey만 받는다. 계좌가 오더보다 먼저 오면 메모리에 잡아뒀다가 판정한다.
  라이트닝 후원자 계좌 수신도 같은 규칙이다.
- **`expiration`**: `listed`는 의뢰 만료, 진행 중은 `max(의뢰 만료, now + 70일)`, 터미널은
  지났으면 `+7일`. 메시지류는 `now + 70일`. **진행 중에 의뢰 만료를 달면 릴레이가
  NIP-40으로 거절한다** — 막바지에 클레임된 주문이 그렇게 멈췄다.
- **오더 `created_at` = `updatedAt`.** `now`를 쓰면 같은 초의 두 갱신 중 id가 작은 쪽이 남는다.
- **`onchain-cosign`은 양방향 · 목적별**: `purpose ∈ release | refund | dispute-customer |
  dispute-sponsor | rescue`. 어드민 → 유저는 **서명 없는** PSBT(릴리스만 후원자 사전서명 포함).
  서명 요청은 주문 × 목적(구조는 × UTXO)으로 따로 쌓인다.
- **`onchain-order-request` content** = NIP-44 `{ refundAddress }` (어드민만 읽는다).
- **`account-info`** 봉투 `{ accountInfo, salt }` + 공개 `commitment` 태그 — 계좌 이의 판정 때
  분쟁 채팅에 공개된 계좌·솔트와 대조한다.
- **`settlement-kind`를 모르는 값이면 오더 이벤트를 버린다** — 서명할 tx를 정하는 값이다.
- 새 오더 태그: `settlement-fee-sat` · `decided-at` · `disputed-at` · `account-disputed-at`.

## 참조 NIP

| NIP | 용도 |
|-----|------|
| NIP-01 | 기본 프로토콜 (이벤트 구조, 서명, 릴레이 통신) |
| NIP-17 | Private Direct Messages (kind 14, 거래 알림) |
| NIP-22 | Comment (kind 1111, 모든 요청 이벤트에 사용) |
| NIP-33 | Addressable event (kind 30000-40000, d-tag) |
| NIP-40 | Expiration Timestamp (`['expiration', timestamp]`) |
| NIP-44 | Versioned Encryption (Admin 전용 데이터 암호화, 계좌정보/분쟁 채팅 E2E 암호화) |
| NIP-46 | Nostr Connect (Admin 원격 서명 + 암호화 위임) |
| NIP-59 | Gift Wrap (kind 13 seal + kind 1059 wrap, 알림 봉투) |
| NIP-65 | Relay List Metadata (kind 10002, outbox model) |
| NIP-78 | Arbitrary Custom App Data (kind 30078, Admin 설정 저장) |
| NIP-99 | Classified Listing (kind 30402, status/price 태그) |
