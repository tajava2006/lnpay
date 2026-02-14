# 사줘 트래커 Nostr Protocol Specification

Customer, Sponsor, Admin 세 앱이 공통으로 참조하는 Nostr 이벤트 프로토콜 명세.

## 시스템 개요

비트코인으로 상품을 결제하고 싶은 Customer와, 거래소 없이 BTC를 매수하고 싶은 Sponsor를
Nostr 릴레이를 통해 연결한다. Admin은 에스크로 서비스를 제공하여 거래의 안전성을 보장한다.

## 앱 Pubkey

```
658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5
```

이 pubkey는 사줘 트래커 시스템 전체를 식별하는 용도이며, 개인키는 Admin(에스크로)만 보유한다.
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

### Outbox Model 적용

| 역할 | 동작 | 대상 릴레이 |
|------|------|------------|
| Customer | 사줘 이벤트 **발행 (write)** | 앱의 **read** 릴레이 |
| Sponsor | 사줘 이벤트 **구독 (read)** | 앱의 **read** 릴레이 |
| Admin | 릴레이 목록 **관리** | kind 10002 이벤트 업데이트 |

Customer가 앱의 read relay에 write하면, Sponsor가 같은 relay에서 read한다.

### 디스커버리 절차

1. Well-known 릴레이(`purplepag.es`, `relay.damus.io`, `nos.lol`, `relay.nostr.band`)에 접속
2. `{ kinds: [10002], authors: [APP_PUBKEY] }` 필터로 조회
3. `['r', url]` 또는 `['r', url, 'read']` 태그에서 read relay 추출
4. 10분마다 갱신 (릴레이 변경에 대응)

## 사줘 요청 이벤트

### Kind

**30402** (NIP-99 Classified Listing, addressable event)

### Addressable Event 주소 체계

```
30402:<customer-pubkey>:<orderId>
```

같은 pubkey + kind + d-tag 조합의 이벤트는 최신 것만 유지된다.
주문 상태가 변경되면 동일 주소로 재발행하여 이전 이벤트를 대체한다.

### Tags

| Tag | Value | 설명 |
|-----|-------|------|
| `d` | orderId | NIP-33 addressable identifier |
| `status` | `active` \| `sold` | NIP-99 리스팅 상태. 내부 상태(detected~selected)는 `active`, 최종 상태(paid/cancelled)는 `sold` |
| `price` | 금액 (string), `KRW` | NIP-99 가격 태그. 입금해야 할 금액과 통화 |
| `expiration` | unix timestamp (seconds) | NIP-40: 무통장입금 기한. 이 시각 이후 릴레이가 이벤트를 삭제할 수 있음 |
| `t` | `sajwo-tracker` | 클라이언트 식별. 다른 30402 이벤트와 구분하기 위한 필수 태그 |
| `p` | 앱 pubkey | 어드민이 `#p` 필터로 모든 이벤트를 조회할 수 있도록 |

### 상태 매핑

| 내부 상태 (TrackedOrder.status) | Nostr status 태그 | 의미 |
|------|------|------|
| `detected` | `active` | 아직 사줘 요청 발송 안 함 (보통 이벤트 발행 전) |
| `requested` | `active` | 사줘 요청 중 |
| `claimed` | `active` | 누군가 사주겠다고 응답 |
| `selected` | `active` | 후원자 선택 완료 |
| `paid` | `sold` | 입금 완료 (최종) |
| `cancelled` | `sold` | 주문 취소 (최종) |

세부 상태(claimed, selected 등)는 요청자의 내부 DB에서 관리하며, Nostr 이벤트에는 노출하지 않는다.
Sponsor는 `active`인 리스팅만 보면 되고, 세부 상태는 1:1 통신(추후 구현)을 통해 전달한다.

### 클레임 흐름 (Sponsor → Admin → Customer)

Sponsor의 클레임이 Customer에 직접 도달하지 않는다.
Admin이 중간에서 Lightning 인바운드 유동성을 검증한 후에만 전달한다.

```
Sponsor                    Admin (에스크로)              Customer
   │                          │                           │
   │  ① 클레임 이벤트 발행     │                           │
   │ ────────────────────────→│                           │
   │                          │  ② 인바운드 유동성 검증     │
   │                          │  (해당 금액의 BTC를        │
   │                          │   수신할 수 있는가?)        │
   │                          │                           │
   │  [유동성 부족 시]          │                           │
   │ ←─── 거절 통보 ──────────│                           │
   │                          │                           │
   │  [유동성 충분 시]          │                           │
   │                          │  ③ 클레임 전달              │
   │                          │──────────────────────────→│
   │                          │                           │  ④ claimed 상태 전이
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
   │ ─────────────────────────────→│
   │                               │  ② invoice 디코딩
   │                               │  ③ probing (랜덤 해시 결제 시도)
   │                               │     - 목적지 도달 → 유동성 충분
   │                               │     - 중간 실패 → 유동성 부족
   │                               │
   │  ④ 승인/거절 통보               │
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
   │                               │                               │
   │                               │  ③ 계좌 정보 전달              │
   │                               │ ─────────────────────────────→│
   │                               │                               │
   │                               │  ④ Sponsor가 KRW 무통장입금    │
   │                               │       (쿠팡 계좌로)            │
   │                               │                               │
   │                               │  ⑤ KRW 입금 확인               │
   │                               │                               │
   │                               │  ⑥ Admin이 hold invoice settle │
   │                               │     → BTC 수령                 │
   │                               │                               │
   │                               │  ⑦ Admin이 Sponsor에게 BTC 전송│
   │                               │ ─────────────────────────────→│
   │                               │                               │
   │  [문제 발생 시]                 │                               │
   │                               │  settle 안 함 → CLTV timeout   │
   │ ←── BTC 자동 환불 ────────────│  후 Customer에게 BTC 반환      │
```

#### Hold Invoice 원리 (에스크로 용도)

1. **Admin이 invoice 생성**: 프리이미지(preimage)를 알고 있는 건 Admin뿐
2. **Customer가 결제**: HTLC가 경로를 따라 전파되어 BTC가 잠김
3. **Admin이 settle**: 프리이미지를 공개하여 BTC를 수령
4. **Admin이 settle 안 함**: CLTV timeout 후 HTLC가 풀려 Customer에게 자동 환불

| 상황 | Admin 행동 | 결과 |
|------|-----------|------|
| KRW 입금 확인됨 | settle | Admin이 BTC 수령 → Sponsor에게 전송 |
| 거래 취소/분쟁 | settle 안 함 | CLTV timeout 후 Customer에게 환불 |

#### Probing vs 에스크로: Hold Invoice 적합성 비교

| 단계 | 방향 | 필요한 제어권 | 방법 | Hold Invoice 적합? |
|------|------|-------------|------|-------------------|
| 유동성 검증 | Admin → Sponsor | 송신자(Admin)가 취소 | Probing (랜덤 hash) | **부적합** (수신자 제어) |
| 에스크로 수금 | Customer → Admin | 수신자(Admin)가 settle | Hold invoice | **적합** (수신자 제어) |

### Content

빈 문자열 (`""`). 모든 정보는 태그로 전달된다.

계좌 정보(bankName, accountNumber 등)는 Sponsor가 선택(selected)된 이후
해당 Sponsor에게만 별도 전달한다 (DM 등, 추후 구현).
Lightning invoice 등 비트코인 결제 정보도 별도 채널로 전달한다.

### 이벤트 예시

```json
{
  "kind": 30402,
  "pubkey": "<customer-pubkey>",
  "created_at": 1770372000,
  "tags": [
    ["d", "123456789"],
    ["status", "active"],
    ["price", "22950", "KRW"],
    ["t", "sajwo-tracker"],
    ["p", "658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5"],
    ["expiration", "1770458336"]
  ],
  "content": "",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

## 구독 필터 (Sponsor/Admin용)

### Sponsor: 사줘 요청 목록

```json
{
  "kinds": [30402],
  "#t": ["sajwo-tracker"]
}
```

`#t` 필터로 사줘 트래커 이벤트만 조회한다. 다른 NIP-99 Classified Listing과 섞이지 않는다.

> **주의**: `#status` 같은 다중 문자 태그 필터는 NIP-01에서 릴레이 인덱싱을 보장하지 않는다.
> 한 글자 태그(`#t`, `#p`, `#d` 등)만 모든 릴레이에서 동작이 보장되므로,
> `status` 필터링은 클라이언트 사이드에서 수행한다 (active → 표시, sold → 삭제).

### Admin: 모든 사줘 이벤트

```json
{
  "kinds": [30402],
  "#t": ["sajwo-tracker"],
  "#p": ["658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5"]
}
```

`#p` 필터로 앱 pubkey가 태깅된 모든 이벤트를 조회한다 (active + sold 모두).

### 특정 유저의 주문 조회

```json
{
  "kinds": [30402],
  "authors": ["<customer-pubkey>"],
  "#t": ["sajwo-tracker"]
}
```

### 특정 주문 조회

```json
{
  "kinds": [30402],
  "authors": ["<customer-pubkey>"],
  "#d": ["123456789"]
}
```

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
   │  ① 사줘 요청 발행               │
   │ ─────────────────────────────→│
   │                               │
   │  ② fidelity bond hold invoice │
   │ ←─────────────────────────────│
   │                               │
   │  ③ hold invoice 결제           │
   │ ─────────────────────────────→│  (BTC 잠김, 오더북에 노출)
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
```

#### BTC 가격 변동 대응

Fidelity bond 시점과 실제 거래 시점의 BTC/KRW 환율이 다를 수 있다.
따라서 fidelity bond는 정확한 금액이 아닌 **보증 목적의 소액**으로 받고,
클레이머 확정 + 유동성 검증 통과 시점에 fidelity bond를 **cancel**(즉시 환불)한 뒤
해당 시점의 정확한 환율로 본 hold invoice를 새로 발행한다.

- LND: `CancelInvoice(payment_hash)` → HTLC 즉시 해제, Customer에게 BTC 반환
- CLN: hold invoice 플러그인의 cancel → 동일
- Cancel 시 원금은 돌아오지만 중간 노드 **라우팅 수수료**(수 sat)는 소실된다 (무시 가능)

> **취소-재발행 윈도우**: Fidelity bond cancel과 본 hold invoice 결제 사이에
> Customer가 이탈할 수 있다. 하지만 이 시점에서 Sponsor는 아직 KRW를 보내지 않았으므로
> Sponsor 손해는 없고, Customer만 거래 기회를 잃는다.

### Sponsor 스팸 차단: Lightning 노드 블랙리스트

Sponsor가 클레임만 하고 KRW를 입금하지 않는 트롤링을 차단한다.

**핵심 인사이트**: Nostr pubkey는 무료로 무한 생성 가능하지만,
Lightning 노드는 채널에 실제 BTC를 lock해야 운영 가능하다.
따라서 **Nostr pubkey가 아닌 Lightning 노드 pubkey**로 Sponsor를 식별한다.

```
Sponsor의 invoice → invoice 디코딩 → destination node pubkey 추출
                                      → 이것이 Sponsor의 실제 식별자
```

**블랙리스트 운영**:
- 트롤링 발생 시 (클레임 후 KRW 미입금 등) 해당 Lightning 노드 pubkey를 블랙리스트에 등록
- 이후 동일 노드에서 발행된 invoice가 포함된 클레임은 자동 거절
- Admin 웹앱에서 블랙리스트 관리 UI 제공

**Sybil 비용**: Lightning 노드 신규 구축에는 채널 펀딩(실제 BTC)이 필요하므로,
블랙리스트 우회를 위한 노드 재생성 비용이 높다.

#### 커스토디얼 월렛 문제 (향후 대응)

커스토디얼 월렛(예: Wallet of Satoshi) 유저는 공유 노드를 사용한다.
트롤이 의도적으로 커스토디얼 노드를 차단되게 만들면 해당 서비스의 모든 유저가 피해를 본다.

이 문제가 실제로 발생하면 RoboSats 방식의 **Sponsor fidelity bond**로 전환을 검토한다:
- Sponsor에게도 주문 금액의 일부(~3%)를 hold invoice로 보증금 수령
- 거래 정상 완료 시 수수료 없이 전액 반환
- 트롤링 시 보증금 몰수

초기에는 소규모 신뢰 기반으로 운영하므로 블랙리스트만으로 충분하며,
규모 확장 시 fidelity bond 도입을 검토한다.

## 유저 키 관리

- Customer/Sponsor 모두 최초 실행 시 `generateSecretKey()`로 랜덤 키페어 생성
- Secret key는 `number[]`로 변환하여 영구저장소에 보관
  - Customer: `chrome.storage.local` (Chrome Extension API)
  - Sponsor: `localStorage` (Web Storage API)
- 키 관리 로직은 `@sajwo-tracker/shared`의 `ensureKeypair(storage)`로 통일
- NIP-07/NIP-46 등 기존 Nostr 로그인 시스템은 사용하지 않음
- 일반 유저 대상이므로 Nostr의 존재를 노출하지 않음

## 참조 NIP

| NIP | 용도 |
|-----|------|
| NIP-01 | 기본 프로토콜 (이벤트 구조, 서명, 릴레이 통신) |
| NIP-22 | Comment (kind 1111, 클레임 이벤트에 사용) |
| NIP-33 | Addressable event (kind 30000-40000, d-tag) |
| NIP-40 | Expiration Timestamp (`['expiration', timestamp]`) |
| NIP-65 | Relay List Metadata (kind 10002, outbox model) |
| NIP-99 | Classified Listing (kind 30402, status/price 태그) |
