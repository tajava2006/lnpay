# 계좌정보 전달 + Sponsor IndexedDB 구현 플랜

> 상태: **아카이브 — 구현 완료**
>
> 당시 계획 기록이다. ⚠️ 여기 설계된 **commitment이 무솔트라 브루트포스 가능**하다는 것이
> 2026-09-13 감사에서 드러났다 → [AUDIT-2026-09-13.md](AUDIT-2026-09-13.md) **A-1**.
> 수정 전까지 이 문서의 커밋먼트 설계를 그대로 따라 쓰면 안 된다.

## 개요

Customer가 hold invoice 결제 후 Sponsor에게 암호화된 계좌정보를 전달하고,
Sponsor가 이를 복호화하여 KRW 송금에 활용하는 기능을 구현한다.
부가적으로 Sponsor 앱에 IndexedDB 영구 저장소를 도입하여 클레임한 오더의 히스토리를 보존한다.

---

## 1. 이벤트 설계: `account-info` (kind 1111)

### 이벤트 구조

```
kind: 1111
tags: [
  ['a', '30402:<APP_PUBKEY>:<orderId>'],   // 오더 참조
  ['action', 'account-info'],               // 새 액션 타입
  ['t', CLIENT_TAG],                        // 클라이언트 식별
  ['p', APP_PUBKEY],                        // Admin 수신 (분쟁 대비 보관)
  ['p', <sponsorPubkey>],                   // Sponsor 수신 (#p 필터)
  ['commitment', sha256(plaintext)],        // 해시 커밋먼트 (분쟁 검증용)
  ['expiration', '<unix_timestamp>'],       // 오더 만료 시각
]
content: NIP-44.encrypt(plaintext, customer_privkey, sponsor_pubkey)
```

### 평문(plaintext) 포맷

```json
{
  "bankName": "국민은행",
  "accountNumber": "123-456-789012",
  "holderName": "홍길동"
}
```

JSON 직렬화 문자열. 추후 다른 결제 수단(가상계좌 등) 확장 가능.

### 암호화 설계

| 역할 | 복호화 가능? | 방법 |
|------|------------|------|
| Customer (발신) | O | 자기 개인키 + Sponsor 공개키 → NIP-44 |
| Sponsor (수신) | O | 자기 개인키 + Customer 공개키 → NIP-44 |
| Admin | X | 공유 비밀 없음 |
| 분쟁 시 Admin | O (간접) | Sponsor가 평문 공개 → sha256(평문) vs commitment 태그 대조 |

- **부인 불가**: commitment 태그가 Customer 서명 이벤트에 포함 → Customer가 "그런 계좌 보낸 적 없다" 부인 불가
- **조작 불가**: Sponsor가 가짜 계좌 제출 → sha256 불일치로 즉시 탐지
- **최소 공개**: 분쟁 시 Sponsor는 평문만 공개하면 됨 (개인키 공개 불필요)

### Relay 선택

읽기 릴레이 (`getReadRelays`). 기존 kind 1111 이벤트와 동일.

---

## 2. Shared 패키지 변경

### 2-1. constants.ts — REQUEST_ACTIONS에 액션 추가

```typescript
export const REQUEST_ACTIONS = {
  ORDER_REQUEST: 'order-request',
  CLAIM: 'claim',
  PAYMENT_CONFIRM: 'payment-confirm',
  CANCEL_REQUEST: 'cancel-request',
  ACCOUNT_INFO: 'account-info',        // 추가
} as const;
```

### 2-2. types.ts — AccountInfo 타입 추가

```typescript
/** 계좌정보 (Customer → Sponsor 암호화 전달) */
export interface AccountInfo {
  bankName: string;
  accountNumber: string;
  holderName: string;
}
```

### 2-3. crypto.ts — NIP-44 유틸리티 (신규)

Customer와 Sponsor 모두 자체 개인키를 보유하므로 NIP-46 없이 직접 NIP-44를 사용할 수 있다.
`nostr-tools/nip44`를 래핑하여 shared에서 공통 제공.

```typescript
import * as nip44 from 'nostr-tools/nip44';

/** NIP-44 암호화 (발신자 개인키 + 수신자 공개키) */
export function nip44Encrypt(
  plaintext: string,
  senderPrivkey: Uint8Array,
  recipientPubkey: string,
): string;

/** NIP-44 복호화 (수신자 개인키 + 발신자 공개키) */
export function nip44Decrypt(
  ciphertext: string,
  receiverPrivkey: Uint8Array,
  senderPubkey: string,
): string;

/** SHA-256 해시 (commitment용) — hex 반환 */
export async function sha256Hex(input: string): Promise<string>;
```

`sha256Hex`는 `crypto.subtle.digest('SHA-256', ...)` 사용.

---

## 3. Customer 앱 변경

### 3-1. types.ts — CustomerOrder에 필드 추가

```typescript
export interface CustomerOrder {
  // ... 기존 필드 ...

  /** Admin 오더에서 수신한 Sponsor pubkey (claimed 이후) */
  sponsorPubkey?: string;

  /** 로컬 저장된 계좌정보 (전달 완료 여부 판별용) */
  accountInfo?: AccountInfo;
}
```

```typescript
export interface AdminOrderUpdate {
  orderId: string;
  adminState: OrderState;
  bolt11?: string;
  sponsorPubkey?: string;    // 추가
}
```

### 3-2. types.ts — parseAdminEvent에서 sponsorPubkey 추출

```typescript
export function parseAdminEvent(event: Event, myPubkey: string): AdminOrderUpdate | null {
  // ... 기존 로직 ...
  const sponsorPubkey = event.tags.find(t => t[0] === 'sponsor')?.[1];
  return { orderId, adminState, bolt11, sponsorPubkey };
}
```

### 3-3. order-store.ts — applyAdminUpdate에서 sponsorPubkey 저장

```typescript
export function applyAdminUpdate(
  orderId: string,
  adminState: OrderState,
  bolt11?: string,
  sponsorPubkey?: string,     // 추가
): void {
  // ... 기존 변경 감지 로직에 sponsorPubkey 추가 ...
}
```

### 3-4. nostr/publish.ts — publishAccountInfo 함수 추가

```typescript
/** 계좌정보를 NIP-44 암호화하여 kind 1111로 발행한다. */
export async function publishAccountInfo(
  order: CustomerOrder,
  accountInfo: AccountInfo,
): Promise<PublishResult> {
  const sk = await getSecretKey(storage);
  const sponsorPubkey = order.sponsorPubkey!;

  const plaintext = JSON.stringify(accountInfo);
  const encrypted = nip44Encrypt(plaintext, sk, sponsorPubkey);
  const commitment = await sha256Hex(plaintext);

  const tags: string[][] = [
    ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${order.orderId}`],
    ['action', 'account-info'],
    ['t', CLIENT_TAG],
    ['p', APP_PUBKEY],            // Admin 수신
    ['p', sponsorPubkey],         // Sponsor #p 필터
    ['commitment', commitment],
  ];

  if (order.expiration > 0) {
    tags.push(['expiration', String(order.expiration)]);
  }

  const template = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: encrypted,
  };

  return signAndPublish(template);
}
```

### 3-5. order-store.ts — setAccountInfo 함수 추가

```typescript
/** 계좌정보 전달 완료 시 로컬 저장 */
export function setAccountInfo(orderId: string, accountInfo: AccountInfo): void {
  const existing = orders[orderId];
  if (!existing) return;
  orders = { ...orders, [orderId]: { ...existing, accountInfo } };
  saveToStorage();
  notify();
}
```

### 3-6. UI — OrderRow.tsx 변경

**버튼 표시 조건:**

| 기존 | 변경 |
|------|------|
| `verified` + `bolt11` → "결제하기" | 동일 (InvoiceModal 유지) |
| `escrowed` → "입금 확인" | 동일 (payment-confirm 유지) |
| (없음) | `verified` + `bolt11` + `sponsorPubkey` + `!accountInfo` → **"결제 완료 + 계좌 전달"** |

**새 버튼 동작:**

1. 클릭 → 계좌 입력 모달/폼 표시 (은행명, 계좌번호, 예금주)
2. 확인 → `publishAccountInfo()` 호출
3. 성공 → `setAccountInfo()` → 로컬 저장소 업데이트 → 버튼 사라짐
4. 이미 전달 완료 (`accountInfo` 존재) → "계좌 전달 완료" 뱃지 표시

**새 컴포넌트:** `AccountInfoModal.tsx`

```tsx
interface Props {
  orderId: string;
  onClose: () => void;
  onSubmit: (info: AccountInfo) => void;
  submitting: boolean;
}
```

은행명(select), 계좌번호(input), 예금주(input) 입력 폼.

### 3-7. UX 흐름 정리

```
[verified + bolt11]
    │
    ├─ "결제하기" → InvoiceModal (bolt11 QR/복사)
    │    └─ 고객이 외부 LN 월렛에서 결제
    │
    └─ "결제 완료 + 계좌 전달" → AccountInfoModal
         └─ 계좌 입력 → 확인
              ├─ publishAccountInfo() → 릴레이 발행
              └─ setAccountInfo() → 로컬 저장
                   └─ UI 자동 반영 (버튼 → 뱃지)
```

에스크로드 상태를 기다리지 않는다. 고객은 자기가 결제한 것을 알고 있으므로
verified 시점에서 바로 계좌정보를 전달할 수 있다.

---

## 4. Admin 앱 변경

### 4-1. 최소 변경 — 현재 스코프에서 Admin은 거의 손댈 것 없음

Admin은 이미 `#p: [APP_PUBKEY]` 필터로 모든 kind 1111을 수신하고 있다.
Customer의 `account-info` 이벤트에는 `['p', APP_PUBKEY]` 태그가 포함되므로
**기존 구독으로 자동 수신**된다.

### 4-2. types.ts — parseRequestEvent에서 account-info 액션 처리

기존 `parseRequestEvent`가 `account-info` 액션을 unknown으로 무시하지 않도록
`REQUEST_ACTIONS.ACCOUNT_INFO`를 허용 액션 목록에 추가.

### 4-3. nostr/service.ts — handleAccountInfo 핸들러

```typescript
function handleAccountInfo(request: ProcessedRequest): void {
  console.log('[Admin] account-info received for order', request.orderId);
  // 현재는 로깅만. 분쟁 해결 도구 구현 시 commitment 검증 로직 추가 예정.
  // content는 암호화되어 있으므로 복호화하지 않음.
}
```

상태 전이 없음. IDB에는 기존 `idbUpsertRequest`로 자동 저장됨 (escrowed 이후 idbMigrateOrder에 포함).

### 4-4. 분쟁 해결 시 활용 (미래)

분쟁 도구 구현 시:
1. Sponsor가 평문 계좌정보를 Admin에게 제출 (별도 kind 1111 또는 DM)
2. Admin이 IDB에서 해당 `account-info` request를 조회
3. `sha256(제출된 평문)` vs `commitment` 태그 대조
4. 일치 → Customer가 보낸 원본 확인됨

---

## 5. Sponsor 앱 변경

### 5-1. kind 1111 구독 추가 — nostr/subscribe.ts

현재 Sponsor는 kind 30402만 구독한다.
**kind 1111 구독을 추가**하여 Customer → Sponsor 메시지를 수신한다.

```typescript
// 새 구독 필터
{
  kinds: [SAJWO_REQUEST_EVENT_KIND],
  '#p': [myPubkey],              // 자기한테 오는 것만
  '#t': [CLIENT_TAG],
  ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
}
```

`#p: [myPubkey]` 필터로 Sponsor 본인에게 향하는 이벤트만 수신.
(Customer가 `['p', sponsorPubkey]` 태그를 포함하여 발송하므로 매칭됨)

### 5-2. types.ts — account-info 이벤트 파싱

```typescript
export interface AccountInfoEvent {
  eventId: string;
  orderId: string;
  customerPubkey: string;    // event.pubkey
  encryptedContent: string;  // NIP-44 암호화된 content
  commitment: string;        // sha256 해시
  createdAt: number;
  expiration: number;
}

export function parseAccountInfoEvent(event: Event): AccountInfoEvent | null {
  const action = event.tags.find(t => t[0] === 'action')?.[1];
  if (action !== 'account-info') return null;

  const aTag = event.tags.find(t => t[0] === 'a')?.[1];
  const orderId = aTag?.split(':')[2];
  if (!orderId) return null;

  const commitment = event.tags.find(t => t[0] === 'commitment')?.[1] ?? '';
  const expiration = Number(event.tags.find(t => t[0] === 'expiration')?.[1] ?? '0');

  return {
    eventId: event.id,
    orderId,
    customerPubkey: event.pubkey,
    encryptedContent: event.content,
    commitment,
    createdAt: event.created_at,
    expiration,
  };
}
```

### 5-3. nostr/service.ts — 구독 서비스 확장

```typescript
export async function startOrderSubscription(): Promise<void> {
  // ... 기존 kind 30402 구독 유지 ...

  // kind 1111 구독 추가 (account-info 수신)
  const myPubkey = await getUserPubkey(storage);
  cleanupRequests = subscribeRequests(relays, myPubkey, {
    onAccountInfo: (event) => {
      const parsed = parseAccountInfoEvent(event);
      if (parsed) handleAccountInfo(parsed);
    },
  });
}
```

### 5-4. 복호화 + 저장

```typescript
async function handleAccountInfo(event: AccountInfoEvent): Promise<void> {
  const sk = await getSecretKey(storage);
  try {
    const plaintext = nip44Decrypt(event.encryptedContent, sk, event.customerPubkey);
    const info: AccountInfo = JSON.parse(plaintext);

    // order-store 또는 별도 store에 저장
    setAccountInfoForOrder(event.orderId, info, event);
  } catch (e) {
    console.error('[Sponsor] account-info 복호화 실패:', event.orderId, e);
  }
}
```

### 5-5. UI — OrderCard.tsx 확장

**클레임한 오더 상세 뷰 또는 카드 확장:**

| 상태 | 표시 |
|------|------|
| `escrowed` + accountInfo 있음 | 계좌정보 표시 (은행명, 계좌번호, 예금주) + "원화 송금했어요" 버튼 |
| `escrowed` + accountInfo 없음 | "계좌 정보 대기 중" 표시 |
| `remitted` | "송금 완료" 뱃지 |

**"원화 송금했어요" 버튼** → 기존 `remit-request` 액션 kind 1111 발행
(이 부분은 기존 FSM의 `escrowed → remitted` 전이에 해당하며, 이미 프로토콜에 정의되어 있지만 Sponsor UI에는 아직 미구현.
이번 플랜에서 함께 구현할지는 범위에 따라 결정. 최소한 계좌정보 표시까지는 이번 스코프.)

### 5-6. 계좌정보 저장소

**방안 A: order-store에 accountInfo 필드 추가**

```typescript
// Sponsor의 로컬 Order 확장 (또는 별도 맵)
const accountInfoMap: Record<string, AccountInfo> = {};
```

간단하지만 localStorage에 민감 정보 저장.

**방안 B: IndexedDB에 저장 (권장)**

아래 5장의 IndexedDB와 통합.
IDB에 `account-info` request를 저장하고, 복호화된 계좌정보도 함께 보관.
만료 삭제에서 보호되며, 분쟁 시 증거로 활용 가능.

→ **방안 B 채택**: IndexedDB 도입과 자연스럽게 통합.

---

## 6. Sponsor IndexedDB 도입

### 6-1. 설계 원칙

- Admin IDB 패턴과 동일 구조 (idb-store.ts)
- 클레임 시점부터 오더 + 관련 request를 영구 보존
- 구독 시 IDB에 이미 있는 오더만 업데이트, 없으면 무시
- localStorage order-store는 기존대로 유지 (오더북 전체 표시용)
- IDB는 "내 히스토리" 전용 (클레임한 건만)

### 6-2. sponsor/src/idb-store.ts (신규)

Admin의 `admin/src/idb-store.ts`와 거의 동일 구조:

```
DB_NAME: 'sponsor-history'
DB_VERSION: 1

Object Stores:
  orders:    PK orderId,  인덱스 createdAt, [state, createdAt]
  requests:  PK eventId,  인덱스 orderId
```

**API:**

```typescript
/** orderId가 IDB에 존재하는지 확인 */
export async function idbHasOrder(orderId: string): Promise<boolean>;

/** 오더 upsert (updatedAt 비교) */
export async function idbUpsertOrder(order: Order): Promise<void>;

/** request upsert */
export async function idbUpsertRequest(request: SponsorRequest): Promise<void>;

/** orderId로 request 조회 */
export async function idbGetRequestsByOrderId(orderId: string): Promise<SponsorRequest[]>;

/** 클레임 시점: 오더 + 자신의 claim request 원자적 저장 */
export async function idbMigrateClaim(
  order: Order,
  claimRequest: SponsorRequest,
): Promise<void>;
```

### 6-3. IDB 저장 시점

| 시점 | 동작 | 트리거 |
|------|------|--------|
| 클레임 발행 | `idbMigrateClaim(order, claimRequest)` | `publishClaim()` 성공 후 |
| 오더 상태 업데이트 | `idbHasOrder()` → 있으면 `idbUpsertOrder()` | 릴레이 kind 30402 수신 시 |
| account-info 수신 | `idbUpsertRequest()` | kind 1111 수신 + 복호화 후 |

### 6-4. 구독 시 IDB 동기화 로직

```typescript
// sponsor/src/nostr/service.ts
onOrder: async (event) => {
  const parsed = parseEvent(event);
  if (!parsed) return;

  // 1. 기존 localStorage 스토어 업데이트 (오더북 전체 표시용)
  upsertOrder(parsed);

  // 2. IDB 동기화 (클레임한 건만)
  const inIdb = await idbHasOrder(parsed.orderId);
  if (inIdb) {
    await idbUpsertOrder(parsed);
  }
}
```

### 6-5. SponsorRequest 타입

```typescript
export interface SponsorRequest {
  eventId: string;
  orderId: string;
  action: string;
  pubkey: string;
  createdAt: number;
  expiration: number;
  /** 복호화된 계좌정보 (account-info 액션인 경우) */
  accountInfo?: AccountInfo;
  /** 원본 이벤트 */
  raw: object;
}
```

---

## 7. 구현 순서 (의존성 기반)

```
Phase 1: Shared 기반 작업
  ├─ 1-a. constants.ts: ACCOUNT_INFO 액션 추가
  ├─ 1-b. types.ts: AccountInfo 타입 추가
  └─ 1-c. crypto.ts: NIP-44 유틸리티 + sha256Hex (신규)

Phase 2: Customer 앱
  ├─ 2-a. types.ts: CustomerOrder에 sponsorPubkey, accountInfo 추가
  ├─ 2-b. types.ts: parseAdminEvent에서 sponsorPubkey 추출
  ├─ 2-c. order-store.ts: applyAdminUpdate에 sponsorPubkey, setAccountInfo 추가
  ├─ 2-d. nostr/publish.ts: publishAccountInfo 구현
  ├─ 2-e. components/AccountInfoModal.tsx: 계좌 입력 모달 (신규)
  └─ 2-f. components/OrderRow.tsx: 새 버튼 + 로직 통합

Phase 3: Admin 앱 (최소 변경)
  ├─ 3-a. types.ts: account-info 액션 허용
  └─ 3-b. nostr/service.ts: handleAccountInfo 핸들러 (로깅만)

Phase 4: Sponsor 앱
  ├─ 4-a. idb-store.ts: IndexedDB 스토어 (신규)
  ├─ 4-b. types.ts: SponsorRequest, AccountInfoEvent 타입 + 파서
  ├─ 4-c. nostr/subscribe.ts: kind 1111 구독 추가
  ├─ 4-d. nostr/service.ts: 구독 확장 + IDB 동기화 + 복호화
  ├─ 4-e. nostr/claim.ts: 클레임 성공 후 idbMigrateClaim 호출
  ├─ 4-f. account-store.ts: 계좌정보 반응형 스토어 (UI 연동)
  └─ 4-g. components/OrderCard.tsx: 계좌정보 표시 UI

빌드 검증: pnpm build:customer && pnpm build:sponsor && pnpm build:admin
```

---

## 8. 변경 파일 요약

| 패키지 | 파일 | 변경 | 비고 |
|--------|------|------|------|
| shared | `constants.ts` | 수정 | ACCOUNT_INFO 액션 |
| shared | `types.ts` | 수정 | AccountInfo 타입 |
| shared | `crypto.ts` | **신규** | NIP-44 + sha256 |
| shared | `index.ts` | 수정 | 새 export |
| customer | `types.ts` | 수정 | sponsorPubkey, accountInfo, parseAdminEvent |
| customer | `order-store.ts` | 수정 | applyAdminUpdate 확장, setAccountInfo |
| customer | `nostr/publish.ts` | 수정 | publishAccountInfo |
| customer | `components/AccountInfoModal.tsx` | **신규** | 계좌 입력 모달 |
| customer | `components/OrderRow.tsx` | 수정 | 새 버튼 |
| admin | `types.ts` | 수정 | account-info 액션 허용 |
| admin | `nostr/service.ts` | 수정 | handleAccountInfo (로깅) |
| sponsor | `idb-store.ts` | **신규** | IndexedDB 스토어 |
| sponsor | `types.ts` | 수정 | SponsorRequest, AccountInfoEvent |
| sponsor | `nostr/subscribe.ts` | 수정 | kind 1111 구독 |
| sponsor | `nostr/service.ts` | 수정 | 구독 확장 + IDB |
| sponsor | `nostr/claim.ts` | 수정 | IDB 이관 |
| sponsor | `account-store.ts` | **신규** | 반응형 계좌정보 스토어 |
| sponsor | `components/OrderCard.tsx` | 수정 | 계좌 표시 UI |

**신규 파일 4개**, 수정 파일 약 15개.

---

## 9. 검토 포인트 (싱크 필요)

### Q1. 계좌 전달 버튼 위치

현재 `verified` 상태에서 "결제하기" 버튼과 함께 "결제 완료 + 계좌 전달" 버튼을 병렬로 노출할 것인지,
아니면 InvoiceModal 닫은 후에만 계좌 전달 버튼을 표시할 것인지?

→ **제안**: 두 버튼 병렬 노출. 고객이 결제를 먼저 하고 계좌를 전달하는 순서는
자연스럽게 유도하되, 강제하지 않음 (어차피 escrowed 전이를 기다리지 않으므로).

### Q2. 계좌정보 재전송

이미 전달 완료된 계좌를 수정/재전송할 수 있게 할 것인지?

→ **제안**: 최초 1회만 가능하게 하고, 재전송은 지원하지 않음.
로컬에 `accountInfo`가 있으면 "전달 완료" 뱃지 표시하고 버튼 비활성화.
(필요하면 추후 추가)

### Q3. Sponsor "송금 완료" 버튼 (escrowed → remitted)

계좌정보 표시까지는 이번 스코프에 확실히 포함.
Sponsor가 "원화 송금했어요"를 눌러 `remit-request` kind 1111을 발행하는 기능까지 이번에 할 것인지?

→ FSM에는 이미 `escrowed → remitted` 전이가 정의되어 있으나, Sponsor 앱에 발행 기능이 없음.
계좌정보 표시와 자연스럽게 이어지므로 **함께 구현하는 것을 권장**하지만, 스코프가 커지면 분리 가능.

### Q4. Sponsor IDB에 계좌정보 평문 저장 여부

복호화된 계좌정보를 IDB에 평문으로 저장하는 것이 보안상 괜찮은지?

→ Sponsor 본인 디바이스의 IndexedDB이므로 큰 문제 없음.
(localStorage에 NIP-44로 암호화하여 저장하는 방안도 있지만, 오버엔지니어링.
Sponsor가 자기 디바이스에서 자기가 받은 데이터를 보는 것이므로.)

---

## 10. 미래 확장점 (이번 스코프 외)

- **분쟁 도구**: Admin UI에서 commitment 검증 + 평문 대조 기능
- **Sponsor remit-request**: "송금 완료" 버튼 (Q3에서 제외 시)
- **다중 결제 수단**: AccountInfo에 `type` 필드 추가 (가상계좌, 토스 송금 등)
- **Sponsor 히스토리 UI**: IDB 데이터를 보는 별도 화면 (Admin 히스토리 UI와 유사)
