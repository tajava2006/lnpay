# Phase 2: 유저스크립트 쿠팡 자동파싱 연동

> 상태: **아카이브 — 구현 완료**
>
> 당시 계획 기록이다. 이후 바뀐 것: `@version` 빌드시각 스탬프 + `@updateURL` 자동 업데이트
> 도입(2026-09-12), 부팅 로그에 APP_PUBKEY 표시. 쿠팡 주문번호를 orderId로 쓰는 설계는
> 재검토 대상이다 → [AUDIT-2026-09-13.md](AUDIT-2026-09-13.md) **A-3**.

## Context

CUSTOMER-MIGRATION.md Phase 2 구현. Tampermonkey 유저스크립트가 쿠팡 주문 페이지에서 무통장입금 주문을 자동 감지하고, Nostr 릴레이를 통해 Customer 웹앱에 알린다. 사용자가 웹앱에서 "사줘 요청" 여부를 결정하면 기존 흐름(order-request → Admin)으로 진행한다.

**핵심 추가 요구사항**: 자동파싱 주문의 계좌정보(쿠팡 가상계좌)는 파싱 시점에 확정되므로, 수동 주문과 달리 사용자가 편집할 수 없도록 잠근다. verified 단계에서 자동 전송한다.

## Architecture

```
유저스크립트 (쿠팡 페이지)              Customer 웹앱
┌──────────────────────────┐           ┌──────────────────────────┐
│ 1. __NEXT_DATA__ → JSON  │           │ 구독:                     │
│    API로 주문 파싱        │  릴레이   │  - kind 30402 (Admin)     │
│ 2. kind 1111 발행:       ├──────────▶│  - kind 1111 #p=self      │
│    parsed-order (#p=self)│           │    → parsed-store         │
│    payment-confirm       │           │    → "감지된 주문" UI      │
│    cancel-request        │           │                           │
│ 3. GM_storage 키 관리    │           │ 사줘 요청 → order-request │
└──────────────────────────┘           │ verified시 auto account-info│
                                       └──────────────────────────┘
```

## 변경 파일 및 구현 내용

### 1. Shared: parsed-order 액션 추가 — `shared/src/constants.ts`

```typescript
export const REQUEST_ACTIONS = {
  ...기존,
  PARSED_ORDER: 'parsed-order',  // NEW
} as const;
```

### 2. Customer 타입 확장 — `customer/src/types.ts`

**CustomerOrder에 필드 추가:**
```typescript
export interface CustomerOrder {
  ...기존 필드...
  /** 주문 출처: 수동 입력 또는 유저스크립트 자동파싱 */
  source?: 'manual' | 'parsed';
  /** 파싱 시 확정된 계좌정보 (parsed 전용, 발송 전 보관) */
  fixedAccountInfo?: AccountInfo;
}
```

- `source`: 'parsed'면 계좌정보 편집 불가, verified시 자동 전송
- `fixedAccountInfo`: 파싱 시점의 쿠팡 가상계좌 정보 (발송 완료 후 `accountInfo`로도 복사)
- `accountInfo`: 기존과 동일하게 "발송 완료" 표시자 역할 유지

**ParsedOrderPayload 타입 추가** (parsed-order 이벤트 content):
```typescript
export interface ParsedOrderPayload {
  coupangOrderId: string;
  productName: string;
  price: number;
  bankName: string;
  accountNumber: string;
  depositor: string;
  expirationDate: number;  // milliseconds
}
```

**parseParsedOrderEvent 함수 추가** — kind 1111 `action=parsed-order` 이벤트를 파싱.

### 3. 파싱 주문 스토어 (NEW) — `customer/src/parsed-store.ts`

Sponsor의 `account-store.ts` 패턴과 동일한 반응형 스토어:

```typescript
type ParsedOrderMap = Record<string, ParsedOrderPayload>;

// useSyncExternalStore 호환 API
export function subscribeParsed(listener: () => void): () => void;
export function getParsedSnapshot(): ParsedOrderMap;

// 뮤테이션
export function addParsedOrder(eventId: string, payload: ParsedOrderPayload): void;
export function removeParsedOrder(eventId: string): void;
export function clearParsedOrders(): void;
```

- 키: Nostr 이벤트 ID (중복 수신 방지)
- 이미 order-store에 동일 coupangOrderId가 있으면 무시 (이미 요청한 건)
- localStorage `customer:parsed-orders`에 영속화

### 4. Customer 구독 확장 — `customer/src/nostr/subscribe.ts`

**subscribeUserscriptEvents 추가:**
```typescript
export function subscribeUserscriptEvents(
  relays: string[],
  myPubkey: string,
  callbacks: { onEvent: (event: Event) => void; onEose: () => void },
): () => void
```
- 필터: `{ kinds: [1111], '#p': [myPubkey], '#t': [CLIENT_TAG] }`
- 자기 pubkey로 발행된 kind 1111 이벤트 수신 (parsed-order, 향후 확장)

### 5. Customer 서비스 확장 — `customer/src/nostr/service.ts`

**startAdminSubscription → startSubscriptions로 확장** (또는 별도 함수):

```typescript
export async function startSubscriptions(): Promise<void> {
  // 기존: Admin kind 30402 구독
  startAdminSubscription();

  // NEW: kind 1111 #p=self 구독
  startUserscriptSubscription();
}
```

**startUserscriptSubscription:**
1. kind 1111 이벤트 수신
2. action 태그로 분기:
   - `parsed-order`: content JSON 파싱 → `addParsedOrder(eventId, payload)`
   - 기타 action은 무시 (Admin 방향 이벤트는 #p=APP_PUBKEY이므로 여기 오지 않음)

**applyAdminUpdate 후 자동 account-info 전송 로직 추가:**
```typescript
// onOrder 콜백 내
if (update.adminState === 'verified' && update.sponsorPubkey) {
  const order = getSnapshot()[update.orderId];
  if (order?.source === 'parsed' && order.fixedAccountInfo && !order.accountInfo) {
    void autoSendAccountInfo(order);
  }
}
```

### 6. Dashboard UI 확장 — `customer/src/components/Dashboard.tsx`

기존 OrderForm 위에 "감지된 주문" 섹션 추가:

```tsx
<ParsedOrdersSection />  {/* NEW */}
<OrderForm />
<h2>주문 목록</h2>
<OrderTable />
```

### 7. ParsedOrdersSection (NEW) — `customer/src/components/ParsedOrdersSection.tsx`

파싱된 주문 카드 리스트:

| 표시 항목 | 출처 |
|-----------|------|
| 쿠팡 주문번호 | coupangOrderId |
| 상품명 | productName |
| 금액 | price (KRW) |
| 입금 계좌 | bankName + accountNumber + depositor |
| 입금 기한 | expirationDate |

**버튼:**
- "사줘 요청" → CustomerOrder 생성 + order-store에 addOrder + publishOrderRequest
  - `orderId = coupangOrderId` (유저스크립트 correlation용)
  - `source = 'parsed'`
  - `fixedAccountInfo = { bankName, accountNumber, holderName: depositor }`
  - `memo = productName`
  - `expiration = Math.floor(expirationDate / 1000)`
- "무시" → `removeParsedOrder(eventId)`

요청 성공 시 parsed-store에서 제거.

### 8. OrderRow 수정 — `customer/src/components/OrderRow.tsx`

**계좌정보 잠금 로직:**
```typescript
const isParsed = order.source === 'parsed';

// 수동 주문: 기존대로 모달 버튼 표시
const showAccountBtn = !isParsed && order.adminState === 'verified'
  && order.sponsorPubkey && !order.accountInfo;

// 파싱 주문: 확정된 계좌정보 읽기전용 표시
const showFixedAccount = isParsed && order.fixedAccountInfo;

// 파싱 주문 verified 단계: 자동 전송 상태 표시
const autoSending = isParsed && order.adminState === 'verified'
  && order.sponsorPubkey && !order.accountInfo;
```

파싱 주문일 때:
- 계좌정보를 읽기전용 텍스트로 표시 (모달 대신)
- verified + sponsorPubkey: "계좌 자동 전달 중..." 표시
- accountInfo 설정 후: "계좌 전달 완료" 뱃지

### 9. nsec 내보내기 UI — `customer/src/components/KeyExport.tsx` (NEW)

유저스크립트에 키를 복사하기 위한 컴포넌트:
- Dashboard 하단 또는 설정 영역에 배치
- "유저스크립트 키" 버튼 → 클릭 시 nsec(bech32) 표시 + 복사 버튼
- `shared/keys.ts`의 `getSecretKey` + `nip19.nsecEncode()` 사용
- 보안 경고 문구 포함

### 10. 유저스크립트 빌드 설정

**`customer/userscript/` 디렉토리 구조:**
```
customer/userscript/
├── src/
│   ├── main.ts          # 엔트리포인트
│   ├── coupang.ts       # 쿠팡 파싱 (customer-extension/src/shared/filter.ts 이식)
│   ├── nostr.ts         # 이벤트 빌드 + WebSocket 발행 (경량 구현)
│   └── storage.ts       # GM_storage 래퍼
├── banner.txt           # Tampermonkey 메타데이터 헤더
└── esbuild.config.mjs   # 빌드 설정
```

**빌드:** `esbuild` IIFE 번들 → `customer/public/sajwo-coupang-parser.user.js`
- nostr-tools/pure (finalizeEvent, getPublicKey) 번들링
- @noble/hashes, @noble/secp256k1 번들링 (nostr-tools 의존성)
- `--banner:js`로 Tampermonkey 메타데이터 헤더 삽입
- 타겟: es2020 (Tampermonkey 환경)

**package.json 스크립트 추가:**
```json
"build:userscript": "node customer/userscript/esbuild.config.mjs"
```

**웹앱에서 유저스크립트 표시:**
- `customer/public/sajwo-coupang-parser.user.js`를 빌드 결과로 생성
- Dashboard에 "유저스크립트 설치 가이드" 링크/버튼 → 빌트 파일을 코드블록으로 표시 + 복사 기능

### 11. 유저스크립트 구현 — `customer/userscript/src/main.ts`

**Tampermonkey 메타데이터** (`banner.txt`):
```
// ==UserScript==
// @name         사줘 트래커 - 쿠팡 파서
// @namespace    sajwo-tracker
// @version      1.0.0
// @description  쿠팡 무통장입금 주문 자동 감지 및 Nostr 릴레이 발행
// @match        https://mc.coupang.com/ssr/desktop/order/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==
```

**main.ts 핵심 로직:**

```typescript
async function main() {
  // 1. 키 확인 (없으면 nsec 입력 프롬프트)
  const nsec = await ensureKey();

  // 2. 릴레이 디스커버리 (캐시 or one-shot fetch)
  const relays = await getRelays();

  // 3. URL에서 orderId 추출
  const orderId = extractOrderIdFromUrl();
  if (!orderId) return;

  // 4. __NEXT_DATA__ 대기 → buildId 추출 → JSON API fetch
  const orderData = await fetchCoupangOrder(orderId);
  if (!orderData) return;

  // 5. 이미 처리한 주문인지 확인 (GM_storage)
  const processed = getProcessedOrders();

  // 6. 신규 무통장입금 주문 → parsed-order 발행
  if (!processed[orderId] && isTargetOrder(orderData, orderId)) {
    const account = extractVirtualAccount(orderData, orderId);
    if (!account) return;

    await publishParsedOrder(nsec, relays, {
      coupangOrderId: orderId,
      productName: extractProductName(orderData, orderId),
      price: account.depositPrice,
      bankName: account.bankName,
      accountNumber: account.accountNumber,
      depositor: account.depositor,
      expirationDate: account.expirationDate,
    });

    markProcessed(orderId, 'parsed');
  }

  // 7. 기존 처리 주문 → 상태 변화 감지
  if (processed[orderId]) {
    if (isCancelled(orderData, orderId) && processed[orderId] !== 'cancelled') {
      await publishCancelRequest(nsec, relays, orderId);
      markProcessed(orderId, 'cancelled');
    } else if (isPaid(orderData, orderId) && processed[orderId] !== 'paid') {
      await publishPaymentConfirm(nsec, relays, orderId);
      markProcessed(orderId, 'paid');
    }
  }
}
```

**coupang.ts**: `customer-extension/src/shared/filter.ts` + `types.ts`에서 이식
- `isTargetOrder`, `extractVirtualAccount`, `extractProductName`, `isPaid`, `isCancelled`
- `waitForNextData`, `fetchCoupangOrder` (content script 로직 이식)

**nostr.ts**: 경량 Nostr 발행 (SimplePool 대신 직접 WebSocket)
- `finalizeEvent` (nostr-tools/pure) — 번들에 포함
- `publishToRelays(signed, relays)` — raw WebSocket으로 EVENT 전송 + OK 대기
- 이벤트 빌드:
  - **parsed-order**: `#p=ownPubkey`, `#t=CLIENT_TAG`, content=JSON
  - **payment-confirm**: `#p=APP_PUBKEY`, `#a=30402:APP_PUBKEY:orderId`
  - **cancel-request**: `#p=APP_PUBKEY`, `#a=30402:APP_PUBKEY:orderId`

**storage.ts**: GM_getValue/GM_setValue 래퍼
- `getKey(): nsec | null`
- `setKey(nsec: string): void`
- `getProcessedOrders(): Record<orderId, status>`
- `markProcessed(orderId, status): void`
- `getCachedRelays(): string[] | null`
- `setCachedRelays(relays): void`

### 12. 유저스크립트 가이드 컴포넌트 — `customer/src/components/UserscriptGuide.tsx` (NEW)

Dashboard 하단에 배치:
- "쿠팡 자동 파싱" 확장 버튼
- 펼치면: 설치 가이드 (단계별 설명) + 유저스크립트 코드블록 + 복사 버튼
- 유저스크립트 내용: `fetch('/sajwo-coupang-parser.user.js')` 후 표시 (빌드 산출물이 public/에 있음)

## 변경 파일 요약

| 파일 | 변경 |
|------|------|
| `shared/src/constants.ts` | `PARSED_ORDER` 액션 추가 |
| `customer/src/types.ts` | CustomerOrder 필드 + ParsedOrderPayload + 파서 |
| `customer/src/parsed-store.ts` | **NEW** 파싱 주문 반응형 스토어 |
| `customer/src/nostr/subscribe.ts` | subscribeUserscriptEvents 추가 |
| `customer/src/nostr/service.ts` | 유저스크립트 구독 + auto account-info |
| `customer/src/App.tsx` | startSubscriptions 호출 변경 |
| `customer/src/components/Dashboard.tsx` | ParsedOrdersSection 추가 |
| `customer/src/components/ParsedOrdersSection.tsx` | **NEW** 파싱 주문 UI |
| `customer/src/components/OrderRow.tsx` | 계좌정보 잠금 로직 |
| `customer/src/components/KeyExport.tsx` | **NEW** nsec 내보내기 |
| `customer/src/components/UserscriptGuide.tsx` | **NEW** 설치 가이드 |
| `customer/userscript/` | **NEW** 유저스크립트 전체 |
| `customer/package.json` | esbuild devDependency |
| `package.json` (root) | build:userscript 스크립트 |

## 구현 순서

1. Shared: REQUEST_ACTIONS 확장
2. Customer 타입: CustomerOrder 확장 + ParsedOrderPayload
3. parsed-store 구현
4. subscribe.ts: 유저스크립트 이벤트 구독
5. service.ts: parsed-order 핸들링 + auto account-info
6. App.tsx: 구독 통합
7. ParsedOrdersSection UI
8. OrderRow: 계좌정보 잠금
9. KeyExport + UserscriptGuide
10. 유저스크립트 빌드 설정 + 구현
11. 문서 업데이트 (ARCHITECTURE.md, PROTOCOL.md)

## 검증

```bash
pnpm build:customer && pnpm build:sponsor && pnpm build:admin
pnpm build:userscript  # 유저스크립트 번들 생성 확인
```

수동 테스트:
- 유저스크립트 → 쿠팡 주문 페이지 → parsed-order 릴레이 발행
- 웹앱 → "감지된 주문" 섹션에 표시
- "사줘 요청" → CustomerOrder 생성 + order-request 발행
- Admin verified → auto account-info 전송 확인
- parsed 주문 계좌정보 수정 불가 확인
- nsec 내보내기 → 유저스크립트 설치 가이드 확인

---

**Created**: 2026-03-01
