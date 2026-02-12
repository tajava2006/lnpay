# 사줘 트래커 Nostr Protocol Specification

Customer, Sponsor, Admin 세 앱이 공통으로 참조하는 Nostr 이벤트 프로토콜 명세.

## 앱 Pubkey

```
658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5
```

이 pubkey는 사줘 트래커 시스템 전체를 식별하는 용도이며, 개인키는 Admin만 보유한다.
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

**30078** (NIP-78 Application-specific data, addressable event)

### Addressable Event 주소 체계

```
30078:<customer-pubkey>:<orderId>
```

같은 pubkey + kind + d-tag 조합의 이벤트는 최신 것만 유지된다.
주문 상태가 변경되면 동일 주소로 재발행하여 이전 이벤트를 대체한다.

### Tags

| Tag | Value | 설명 |
|-----|-------|------|
| `d` | orderId | NIP-33 addressable identifier |
| `status` | `detected` \| `requested` \| `claimed` \| `selected` \| `paid` \| `cancelled` | 현재 주문 상태 |
| `amount` | 금액 (string), `KRW` | 입금해야 할 금액과 통화 |
| `expiration` | unix timestamp (seconds) | NIP-40: 무통장입금 기한. 이 시각 이후 릴레이가 이벤트를 삭제할 수 있음 |

### Content

`TrackedOrder` 객체의 JSON 문자열:

```json
{
  "orderId": "123456789",
  "productName": "샌디스크 메모리 256기가, 1개",
  "amount": 22950,
  "status": "requested",
  "createdAt": 1770371936000,
  "updatedAt": 1770372000000,
  "version": 2,
  "virtualAccount": {
    "bankName": "농협은행",
    "bankCode": "BK11",
    "accountNumber": "79140000000000",
    "depositor": "쿠팡",
    "depositPrice": 22950,
    "expirationDate": 1770458336000
  }
}
```

### 이벤트 예시

```json
{
  "kind": 30078,
  "pubkey": "<customer-pubkey>",
  "created_at": 1770372000,
  "tags": [
    ["d", "123456789"],
    ["status", "requested"],
    ["amount", "22950", "KRW"],
    ["expiration", "1770458336"]
  ],
  "content": "{\"orderId\":\"123456789\",\"productName\":\"샌디스크 메모리 256기가, 1개\",\"amount\":22950,...}",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

## 구독 필터 (Sponsor/Admin용)

### 활성 사줘 요청 목록 조회

```json
{
  "kinds": [30078],
  "#status": ["requested"]
}
```

### 특정 유저의 모든 주문 조회

```json
{
  "kinds": [30078],
  "authors": ["<customer-pubkey>"]
}
```

### 특정 주문 조회

```json
{
  "kinds": [30078],
  "authors": ["<customer-pubkey>"],
  "#d": ["123456789"]
}
```

## 유저 키 관리

- Customer 앱 설치 시 `generateSecretKey()`로 랜덤 키페어 생성
- `chrome.storage.local`에 저장 (secret key는 `number[]`로 변환)
- NIP-07/NIP-46 등 기존 Nostr 로그인 시스템은 사용하지 않음
- 일반 유저 대상이므로 Nostr의 존재를 노출하지 않음

## 참조 NIP

| NIP | 용도 |
|-----|------|
| NIP-01 | 기본 프로토콜 (이벤트 구조, 서명, 릴레이 통신) |
| NIP-33 | Addressable event (kind 30000-40000, d-tag) |
| NIP-40 | Expiration Timestamp (`['expiration', timestamp]`) |
| NIP-65 | Relay List Metadata (kind 10002, outbox model) |
| NIP-78 | Application-specific data (kind 30078) |
