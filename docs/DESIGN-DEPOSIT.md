# S-001 보증금(Fidelity Bond) 설계 문서

> 상태: **아카이브 — 구현 완료, 단 운영에서는 꺼져 있음**
>
> S-001 보증금 메커니즘은 구현돼 있으나 `deposit-config.ts`의 기본값이 **0(비활성)**이고
> 운영에서도 꺼둔 상태다. 즉 이 문서가 서술하는 스팸 차단은 **현재 작동하지 않는다.**
> 켜려면 Admin 설정에서 비율을 올리면 된다. 관련 → [AUDIT-2026-09-13.md](AUDIT-2026-09-13.md) B-1.

> Customer 스팸/DoS 차단을 위한 소액 hold invoice 보증금 메커니즘.
> SECURITY-ROADMAP.md S-001 구현 설계.

## 개요

주문 생성 시 결제 금액의 일정 비율을 보증금으로 사전 결제하도록 하여
가짜 주문으로 오더북을 오염시키는 스팸/DoS를 근본적으로 차단한다.

보증금은 hold invoice로 잡아두며, 실결제(에스크로) 완료 시 환불한다.
보증금 비율이 0이면 기존 플로우와 동일하게 동작한다.

**핵심 설계 결정**: 보증금은 오더 생명주기(FSM)의 일부가 아니라 **오더 생성 전 관문**이다.
FSM에 새 상태를 추가하지 않고, 보증금 결제 전까지 오더 발행을 지연한다.

## 설정

- **저장소**: Admin localStorage (`admin:depositPercent`)
- **릴레이 백업 불필요**: 앱 설정값이지 거래 데이터가 아님
- **기본값**: 0 (보증금 비활성)
- **범위**: 0~100 (정수, 퍼센트)
- **UI**: Admin 페이지 상단에 인라인 설정 컨트롤

## 플로우

### 기존 (depositPercent == 0)

```
Customer: order-request (kind 1111)
  → Admin: 즉시 오더 발행 (kind 30402, state: requested)
  → Sponsor 오더북에 표시
```

### 변경 후 (depositPercent > 0)

```
Customer: order-request (kind 1111)
  → Admin: 보증금 hold invoice 생성
  → Admin: deposit-required 알림 발행 (kind 1111, bolt11 포함)
  → Customer: 알림 수신 → InvoiceModal 표시 → 보증금 결제
  → Admin: invoice-watcher가 보증금 결제 감지 (accepted)
  → Admin: 오더 발행 (kind 30402, state: requested)  ← 기존과 동일
  → Sponsor 오더북에 표시
```

### 상태 머신

**변경 없음.** 기존 FSM을 그대로 유지한다.

```
requested → claimed → verified → escrowed → remitted → paid
                                    │                ├──→ sponsor_wins
                                    └──→ paid        └──→ customer_wins

cancelled: requested, claimed, verified에서만 전이 가능
```

보증금은 FSM 진입 전(pre-order) 단계에서 처리되므로 상태 머신에 영향 없음.

## deposit-required 알림 (kind 1111)

Admin이 Customer에게 보증금 인보이스를 전달하는 알림 이벤트.
기존 `claim-price-error` 패턴과 동일한 구조.

### 태그

| Tag | Value | 설명 |
|-----|-------|------|
| `a` | `30402:<admin-pubkey>:<orderId>` | 대상 오더 참조 (아직 발행 전이지만 주소는 구성 가능) |
| `action` | `deposit-required` | 알림 종류 |
| `t` | CLIENT_TAG | 클라이언트 식별 |
| `p` | customerPubkey | Customer가 `#p` 필터로 수신 |
| `bolt11` | deposit invoice | 보증금 hold invoice |
| `expiration` | unix timestamp | order-request와 동일한 만료 시각 |

> Customer는 이미 kind 1111을 `#p` 필터로 구독 중이므로 별도 구독 추가 불필요.

## 보증금 hold invoice 생명주기

보증금의 cancel/settle은 **오더에 sponsorPubkey가 있는지** (= Sponsor가 클레임했는지)로 판단한다.

### 오더 생성 전 (pending-deposit 단계)

| 이벤트 | 보증금 처리 | 사유 |
|--------|-----------|------|
| 보증금 결제 감지 (accepted) | 유지 (hold) | 오더 생성 진행 |
| 보증금 만료/취소 (cancelled) | 자동 환불 | 오더 미생성, 폐기 |
| Admin 재시작 | catch-up 폴링 | pending-deposit-store에서 복원 |

### 오더 생성 후 (requested ~ verified)

| 오더 상태 전이 | sponsorPubkey | 보증금 처리 | 사유 |
|---------------|:---:|-----------|------|
| requested → cancelled | 없음 | **cancel (환불)** | Sponsor 관여 전 |
| claimed → cancelled | 있음 | **settle (몰수)** | Sponsor 시간 낭비 |
| verified → cancelled | 있음 | **settle (몰수)** | Sponsor 시간 낭비 |
| verified → escrowed | 있음 | **cancel (환불)** | 실결제가 담보 역할 인수 |

> **원칙**: 실결제(escrowed) 이후 모든 트롤링 시나리오는 실결제 hold invoice가 담당한다.
> 보증금은 escrowed 이전 단계에서만 의미가 있다.

### 만료 시 자동 처리

cleanup이 만료된 오더를 삭제할 때, 보증금 hold invoice가 아직 살아있으면:
- `sponsorPubkey` 없음 → cancel (환불)
- `sponsorPubkey` 있음 → settle (몰수)

## 보증금 금액 계산

```
depositSats = round(orderPriceKRW / btcKrwPrice * 1e8 * depositPercent / 100)
```

- `btcKrwPrice`: Admin PriceTracker에서 조회
- 시세 조회 실패 시: 보증금 생성 불가 → 기존 플로우로 폴백 (requested 즉시 발행)

## 데이터 모델

### Admin: pending-deposit-store (신규)

오더 발행 전 보증금 대기 상태를 추적하는 저장소.
보증금 결제 완료 또는 만료 시 엔트리 삭제.

```typescript
interface PendingDeposit {
  orderId: string;
  customerPubkey: string;
  price: number;
  expiration: number;
  depositPaymentHash: string;  // hold invoice lookup용
  depositBolt11: string;       // 참조용 (이미 Customer에게 전달됨)
  createdAt: number;
}
```

- **저장소**: Admin localStorage (`admin:pending-deposits`)
- **키**: orderId
- **생명주기**: order-request 수신 시 생성 → 보증금 결제 감지 시 삭제 (오더 생성) 또는 만료 시 삭제

### Admin: escrow-store 확장

보증금 프리이미지는 기존 escrow-store에 `deposit:${orderId}` 키로 저장.
기존 실결제 프리이미지(`${orderId}`)와 키 네임스페이스 분리.

### shared: Order 타입에 보증금 필드 추가

```typescript
export interface Order {
  // ...기존 필드
  /** 보증금 hold invoice payment hash (cancel/settle용) */
  depositPaymentHash?: string;
}
```

> `depositBolt11`은 Order에 불필요. Customer에게는 kind 1111 알림으로 전달되고,
> 오더 생성 후에는 payment hash만 있으면 cancel/settle 가능.

### shared: constants.ts — RequestAction 추가

```typescript
export const REQUEST_ACTIONS = {
  // ...기존
  DEPOSIT_REQUIRED: 'deposit-required',  // 추가
} as const;
```

## 앱별 변경 상세

### Admin

#### 1. pending-deposit-store.ts (신규)

```typescript
// localStorage 기반 pending deposit 관리
function savePendingDeposit(deposit: PendingDeposit): void;
function getPendingDeposit(orderId: string): PendingDeposit | null;
function deletePendingDeposit(orderId: string): void;
function getAllPendingDeposits(): PendingDeposit[];
function purgeExpiredDeposits(): string[];  // 만료된 deposit 삭제, orderId 목록 반환
```

#### 2. handleOrderRequest 분기

```
order-request 수신
  ├─ depositPercent == 0 → 기존 로직 (오더 즉시 발행, state: requested)
  └─ depositPercent > 0
       ├─ PriceTracker에서 BTC 시세 조회 (실패 시 → 기존 로직으로 폴백)
       ├─ depositSats 계산
       ├─ 보증금 hold invoice 생성 (LN 어댑터)
       ├─ 프리이미지를 escrow-store에 deposit:orderId로 저장
       ├─ pending-deposit-store에 저장
       ├─ deposit-required 알림 발행 (kind 1111)
       └─ 오더는 아직 발행하지 않음
```

#### 3. invoice-watcher 확장

기존 Phase 1(verified) 앞에 **Phase 0** 추가:

```
Phase 0: pending deposit — 보증금 invoice 상태 감시
  - pending-deposit-store에서 전체 목록 조회
  - 각 항목의 depositPaymentHash로 LN 노드 조회
  - accepted: 오더 발행 (state: requested) + pending deposit 삭제
  - cancelled: pending deposit 삭제 (오더 미생성)
  - open: 스킵 (미결제)
```

#### 4. 보증금 cancel/settle 훅

오더 상태 전이 시 보증금 hold invoice 자동 처리.
`handleDepositOnTransition(order, newState)` 헬퍼:

- **→ escrowed**: 보증금 cancel (환불)
- **→ cancelled**: `sponsorPubkey` 유무에 따라 cancel (환불) 또는 settle (몰수)

호출 지점:
- invoice-watcher: verified → escrowed 전이 시
- handleCancelRequest: → cancelled 전이 시
- cleanup: 만료 오더 삭제 시

#### 5. cleanup.ts 확장

- 만료 오더 삭제 시 `deposit:${orderId}` 프리이미지도 함께 purge
- `purgeExpiredDeposits()` 호출 추가: 오더 미생성 상태로 만료된 보증금 정리
  - 만료된 보증금의 hold invoice cancel (best-effort)

#### 6. nostr/publish.ts

`publishDepositRequired(orderId, customerPubkey, bolt11, expiration)` 함수 추가.
기존 `publishClaimPriceError`와 동일한 패턴.

#### 7. nostr/publish.ts — publishOrder

Order에 `depositPaymentHash`가 있으면 `deposit-payment-hash` 태그 추가.

#### 8. types.ts — parseOrderEvent

`deposit-payment-hash` 태그 파싱 추가.

#### 9. Admin UI

- 상단에 depositPercent 인라인 설정 (숫자 입력 + 저장 버튼)
- 또는 프리셋 버튼 (0%, 1%, 3%, 5%)

### Customer

#### 1. deposit-required 알림 처리

Customer nostr 구독 서비스에서 `deposit-required` action 수신 시:
- orderId로 로컬 주문 매칭
- `depositBolt11` 필드를 주문에 저장

#### 2. OrderRow.tsx — 보증금 결제 UI

주문이 "요청 대기" 상태(Admin 미응답)이고 `depositBolt11`이 있으면:
- 기존 InvoiceModal 재사용하여 보증금 인보이스 표시
- 헤더: "보증금 결제" (기존 "Lightning 결제"와 구분)
- 보증금 결제 후 Admin이 오더를 발행하면 "요청됨" 상태로 자동 전환

#### 3. types.ts

`CustomerOrder`에 `depositBolt11?: string` 필드 추가.
`parseAdminEvent`는 변경 불필요 (보증금 인보이스는 kind 1111로 수신).

### Sponsor

#### 변경 없음

- 보증금 미결제 주문은 kind 30402가 아예 발행되지 않으므로 Sponsor에게 보이지 않음
- 기존 로직 변경 불필요

## 구현 순서

```
 1. shared: REQUEST_ACTIONS에 DEPOSIT_REQUIRED 추가
 2. shared: Order에 depositPaymentHash 필드 추가
 3. Admin: pending-deposit-store.ts 신규 생성
 4. Admin: depositPercent 설정 (localStorage read/write + UI)
 5. Admin: nostr/publish.ts에 publishDepositRequired 추가
 6. Admin: handleOrderRequest 분기 (보증금 생성 + deposit-required 발행)
 7. Admin: escrow-store에 보증금 preimage 저장 (deposit: 프리픽스)
 8. Admin: invoice-watcher Phase 0 (pending deposit 감시 → 오더 발행)
 9. Admin: handleDepositOnTransition 헬퍼 (cancel/settle 훅)
10. Admin: cleanup 확장 (만료 deposit 정리 + deposit preimage purge)
11. Admin: publish.ts/types.ts에 deposit-payment-hash 태그 직렬화/역직렬화
12. Customer: deposit-required 알림 수신 처리
13. Customer: OrderRow에 보증금 InvoiceModal 표시
14. 빌드 확인: pnpm build:customer && pnpm build:sponsor && pnpm build:admin
15. PROTOCOL.md, ARCHITECTURE.md 업데이트
```

## 엣지 케이스

### E-001. 보증금 결제 후 오더 만료

보증금 hold invoice는 오더와 동일한 만료를 갖는다.
오더가 만료되면 cleanup이 보증금도 cancel/settle 처리.

### E-002. Admin 오프라인 중 보증금 결제

pending-deposit-store가 localStorage에 영속 저장되어 있으므로,
Admin 재시작 시 invoice-watcher Phase 0이 catch-up 폴링으로 감지.
보증금 hold invoice가 accepted 상태면 오더 발행 진행.

### E-003. 시세 조회 실패

PriceTracker 데이터 없이 보증금 계산 불가.
→ 보증금 없이 requested로 즉시 오더 생성 (폴백).
로그 경고: `[Admin] Price unavailable, skipping deposit for orderId`.

### E-004. 보증금 hold invoice CLTV timeout

보증금 hold invoice도 실결제와 동일한 CLTV 마진 적용.
timeout 발생 시 BTC 자동 환불 → invoice-watcher가 cancelled 감지 → pending deposit 삭제.

### E-005. depositPercent 실시간 변경

이미 생성된 pending deposit이나 오더에는 영향 없음 (생성 시점의 비율 적용).
새 order-request부터 변경된 비율 적용.

### E-006. 동일 orderId로 중복 order-request

기존 동작: `getOrder(orderId)`로 중복 체크 → 오더 존재 시 무시.
변경 후: pending-deposit-store에도 중복 체크 추가 → pending deposit 존재 시 무시.

### E-007. Customer가 deposit-required를 수신하지 못함

릴레이 장애 등으로 Customer가 알림을 놓칠 수 있음.
→ Customer는 "요청 대기" 상태에 머무름 (보증금 인보이스를 모름)
→ 보증금 hold invoice 만료 시 자연 소멸
→ Customer가 재주문하면 새 deposit-required 발행
> 향후 개선: Customer가 "요청 대기" 상태에서 Admin에게 재요청하는 UX 추가 가능
