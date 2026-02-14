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
| NIP-33 | Addressable event (kind 30000-40000, d-tag) |
| NIP-40 | Expiration Timestamp (`['expiration', timestamp]`) |
| NIP-65 | Relay List Metadata (kind 10002, outbox model) |
| NIP-99 | Classified Listing (kind 30402, status/price 태그) |
