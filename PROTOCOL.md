# 사줘 트래커 Nostr Protocol Specification

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

#### ③ Admin → User 알림 → 쓰기 릴레이 (미구현)

Admin이 발행하고 Customer/Sponsor가 읽어야 할 알림 이벤트.
예: 클레임 유동성 검증 완료 통보, 에스크로 상태 알림 등.

| 역할 | 동작 | 대상 릴레이 |
|------|------|------------|
| Admin | 알림 이벤트 **발행** | 앱의 **쓰기** 릴레이 |
| Customer/Sponsor | 알림 이벤트 **구독** | 앱의 **쓰기** 릴레이 |

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

**Admin만 발행한다.** Customer/Sponsor는 kind 30402를 발행하지 않는다.

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
| `expiration` | unix timestamp (seconds) | NIP-40: 무통장입금 기한. 이 시각 이후 릴레이가 이벤트를 삭제할 수 있음 |
| `t` | `sajwo-tracker` | 클라이언트 식별. 다른 30402 이벤트와 구분하기 위한 필수 태그 |

### 상태 머신 (Admin 단일 FSM)

```
requested → claimed → verified → escrowed ─→ remitted ─→ paid
                                    │                ├──→ sponsor_wins
                                    └──→ paid        └──→ customer_wins

cancelled: requested, claimed, verified에서만 전이 가능
  (escrowed 이후는 상대방이 행동할 수 있으므로 일방 취소 불가)
터미널: paid, cancelled, sponsor_wins, customer_wins
```

| 상태 | 의미 | NIP-99 status |
|------|------|---------------|
| `requested` | Customer가 사줘 요청을 보냄, Admin이 오더 생성 | `active` |
| `claimed` | Sponsor가 클레임, Admin이 수락 | `active` |
| `verified` | Admin이 유동성 검증 완료 | `active` |
| `escrowed` | Customer가 hold invoice 결제, BTC 에스크로 중 | `active` |
| `remitted` | Sponsor가 KRW 송금했다고 주장 | `active` |
| `paid` | 거래 완료 — Customer가 입금 확인 (최종) | `sold` |
| `cancelled` | 취소 — 거래 불발 (최종) | `sold` |
| `sponsor_wins` | 분쟁: 후원자 승리 — Admin이 송금 증거 확인, hold invoice settle (최종) | `sold` |
| `customer_wins` | 분쟁: 고객 승리 — 송금 증거 불충분, hold invoice 환불 (최종) | `sold` |

상태 전이 규칙:

| from | to | 트리거 |
|------|-----|--------|
| requested | claimed | Sponsor claim 수신 + Admin 수락 |
| requested | cancelled | 만료 또는 Customer 취소 |
| claimed | verified | Admin 유동성 검증 완료 |
| claimed | cancelled | 만료 또는 취소 |
| verified | escrowed | Customer hold invoice 결제 |
| verified | cancelled | Customer 이탈 |
| escrowed | remitted | Sponsor가 KRW 송금 완료 주장 |
| escrowed | paid | Customer가 직접 입금 확인 (Sponsor 시그널 없이) |
| remitted | paid | Customer가 입금 확인 |
| remitted | sponsor_wins | 분쟁: Admin이 송금 증거 확인 → hold invoice settle → Sponsor에게 BTC 전달 |
| remitted | customer_wins | 분쟁: 증거 불충분 → hold invoice 환불 → Customer BTC 반환 |

> `escrowed` 이후 상태에서는 `cancelled`로 전이할 수 없다.
> 에스크로가 잡힌 시점부터 Sponsor가 행동할 수 있으므로, Customer 일방의 취소를 허용하면
> 어뷰징 벡터가 생긴다 (상세: [THREAT-MODEL.md](THREAT-MODEL.md) §T-002).
> Sponsor가 미행동 시 hold invoice는 CLTV timeout으로 자동 환불되며, 앱 상태는 `escrowed`로 유지된다.
> `remitted`는 반드시 분쟁 판정(paid / sponsor_wins / customer_wins)으로만 종결된다.

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
  "pubkey": "658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5",
  "created_at": 1770372000,
  "tags": [
    ["d", "123456789"],
    ["status", "active"],
    ["state", "requested"],
    ["customer", "<customer-pubkey>"],
    ["price", "22950", "KRW"],
    ["t", "sajwo-tracker"],
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
| `expiration` | unix timestamp (seconds) | 관련 오더와 동일한 만료 시각 |

### 요청 종류 (action 태그 값)

| action | 발행자 | 설명 | 추가 태그 |
|--------|--------|------|-----------|
| `order-request` | Customer | 사줘 요청 신청 | `['price', 금액, 'KRW']` |
| `claim` | Sponsor | 클레임 신청 | `['bolt11', invoice]` |
| `payment-confirm` | Customer | 입금 완료 신고 | — |
| `cancel-request` | Customer | 주문 취소 신고 | — |
| `account-info` | Customer | Sponsor에게 계좌정보 전달 | `['p', sponsorPubkey]`, `['commitment', sha256(plaintext)]` |
| `remit-request` | Sponsor | 원화 송금 완료 통보 | — |
| `dispute-message` | Customer / Sponsor / Admin | 분쟁 채팅 메시지 (NIP-44 암호화) | `['p', recipientPubkey]`, content=NIP-44 JSON |
| `parsed-order` | Customer (유저스크립트) | 쿠팡 주문 자동 감지 알림 | `['p', ownPubkey]`, content=JSON |

### a-tag 참조 규칙

모든 kind 1111 요청은 대상 오더의 a-tag(`30402:<admin-pubkey>:<orderId>`)를 포함한다.
최초 `order-request` 시점에는 아직 해당 kind 30402 이벤트가 릴레이에 존재하지 않지만,
addressable event의 주소(`30402:<admin-pubkey>:<orderId>`)는 구성 요소가 모두 알려져 있으므로 a-tag을 넣을 수 있다.
Nostr 릴레이는 a-tag 대상 이벤트의 존재 여부를 검증하지 않는다.

### 만료 태그 통일

오더와 관련된 모든 kind 1111 이벤트에 오더와 동일한 만료 시각을 부여한다.

- 오더가 만료되면 관련된 모든 요청 이벤트도 릴레이에서 함께 정리된다
- 만료된 과거 요청이 릴레이에 남아 불필요하게 수신되는 것을 방지한다
- Admin이 오프라인이었다가 복귀했을 때, 이미 만료된 요청을 받아 처리하려는 상황을 차단한다

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
    ["a", "30402:658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5:123456789"],
    ["action", "order-request"],
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

### 이벤트 예시: claim

```json
{
  "kind": 1111,
  "pubkey": "<sponsor-pubkey>",
  "created_at": 1770372100,
  "tags": [
    ["a", "30402:658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5:123456789"],
    ["action", "claim"],
    ["bolt11", "lnbc229500n1p..."],
    ["t", "sajwo-tracker"],
    ["p", "658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5"],
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
    ["a", "30402:658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5:123456789"],
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

### Customer — 자기 오더 상태 추적

```json
{
  "kinds": [30402],
  "authors": ["658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5"],
  "#t": ["sajwo-tracker"]
}
```

Admin이 발행한 모든 오더를 수신한 뒤, `customer` 태그가 자기 pubkey인 오더만 클라이언트 사이드에서 필터링한다.

> `#customer`는 다중 문자 태그이므로 릴레이 인덱싱이 보장되지 않는다.
> `authors` + `#t`까지만 서버에서 필터링하고, `customer` 매칭은 클라이언트에서 수행한다.

### Customer — 유저스크립트 알림 수신

```json
{
  "kinds": [1111],
  "#p": ["<customer-own-pubkey>"],
  "#t": ["sajwo-tracker"]
}
```

유저스크립트가 자기 pubkey를 `p` 태그에 넣어 발행한 `parsed-order` 이벤트를 수신한다.
Admin/Sponsor는 이 이벤트를 수신하지 않는다 (p 태그가 APP_PUBKEY가 아니므로).
수신된 파싱 데이터는 "감지된 주문" 목록으로 표시되며, 사용자가 사줘 요청 여부를 결정한다.

### Sponsor — 오더북

```json
{
  "kinds": [30402],
  "authors": ["658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5"],
  "#t": ["sajwo-tracker"]
}
```

Admin이 발행한 모든 오더를 수신한다. `state` 태그로 활성/종료 상태를 클라이언트 사이드에서 필터링한다.

### Admin — 요청 수신

```json
{
  "kinds": [1111],
  "#p": ["658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5"],
  "#t": ["sajwo-tracker"]
}
```

모든 Customer/Sponsor의 요청을 `#p` 필터로 수신한다.
`action` 태그로 요청 종류를 분류한다.

### Admin — 자기 오더 동기화

```json
{
  "kinds": [30402],
  "authors": ["658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5"],
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
   │                               │  ⑤ KRW 입금 확인               │
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
| KRW 입금 확인됨 | settle | Admin이 BTC 수령 → Sponsor에게 전송 |
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
- Secret key는 `number[]`로 변환하여 localStorage에 보관
- 키 관리 로직은 `@sajwo-tracker/shared`의 `ensureKeypair(storage)`로 통일
- NIP-07/NIP-46 등 기존 Nostr 로그인 시스템은 사용하지 않음 (Customer/Sponsor용)
- Admin은 NIP-46 원격 서명을 사용하여 `.env` 의존성 없이 동작
- 유저스크립트 키 공유: Customer 웹앱에서 nsec(bech32) 표시 → Tampermonkey에 1회 입력 → GM_storage 보관
- 일반 유저 대상이므로 Nostr의 존재를 노출하지 않음

## 참조 NIP

| NIP | 용도 |
|-----|------|
| NIP-01 | 기본 프로토콜 (이벤트 구조, 서명, 릴레이 통신) |
| NIP-22 | Comment (kind 1111, 모든 요청 이벤트에 사용) |
| NIP-33 | Addressable event (kind 30000-40000, d-tag) |
| NIP-40 | Expiration Timestamp (`['expiration', timestamp]`) |
| NIP-44 | Versioned Encryption (Admin 전용 데이터 암호화, 계좌정보/분쟁 채팅 E2E 암호화) |
| NIP-46 | Nostr Connect (Admin 원격 서명 + 암호화 위임) |
| NIP-65 | Relay List Metadata (kind 10002, outbox model) |
| NIP-78 | Arbitrary Custom App Data (kind 30078, Admin 설정 저장) |
| NIP-99 | Classified Listing (kind 30402, status/price 태그) |
