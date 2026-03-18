# 리팩터링 플랜

> 기능 변경 없이 코드 정리만 수행한다. 중복 제거, 네이밍 통일, 파일 위치 조정이 목표.

## P0: 100% 동일 코드 → shared 이동

즉시 실행 가능. 각 앱에서 삭제 후 shared에서 단일 관리한다.

### 1. `chat-store.ts` (3개 앱 100% 동일, 86줄)

- `customer/src/chat-store.ts`
- `sponsor/src/chat-store.ts`
- `admin/src/chat-store.ts`

→ `shared/src/chat-store.ts`로 이동, 각 앱에서 `@sajwo-tracker/shared`로 import 변경.

### 2. `nostr/storage.ts` (3개 앱 100% 동일, 4~5줄)

- `customer/src/nostr/storage.ts`
- `sponsor/src/nostr/storage.ts`
- `admin/src/nostr/storage.ts`

→ `shared/src/storage.ts`에서 싱글턴 인스턴스를 직접 export하거나, 각 앱의 import 경로만 통일.

### 3. `components/BtcPrice.tsx` (3개 앱 100% 동일)

- `customer/src/components/BtcPrice.tsx`
- `sponsor/src/components/BtcPrice.tsx`
- `admin/src/components/BtcPrice.tsx`

→ `shared/src/components/BtcPrice.tsx`로 이동.

### 4. `components/KeyInit.tsx` (customer↔sponsor 99% 동일, 주석 1줄 차이)

- `customer/src/components/KeyInit.tsx`
- `sponsor/src/components/KeyInit.tsx`

→ `shared/src/components/KeyInit.tsx`로 이동.

---

## P1: 높은 중복률 코드 공통화

### 5. `idb-store.ts` 공통 함수 추출 (65-70% 동일)

아래 함수들이 앱 간 100% 동일:
- `idbUpsertMessage()`, `idbGetMessagesByOrderId()` (3개 앱)
- `idbGetOrder()`, `idbUpsertOrder()`, `idbGetOrdersPage()` (sponsor↔admin)
- `openDb()` 싱글턴 패턴 (DB_NAME만 다름)

→ `shared/src/idb-store.ts`에 공통 함수 추출. DB_NAME은 인자로 받는다.
→ 앱별 마이그레이션 함수(`idbMigrateClaim`, `idbMigrateOrder`)는 로컬에 유지.

### 6. `handleDisputeMessage()` 추출

- `customer/src/nostr/service.ts`
- `sponsor/src/nostr/service.ts`
- `admin/src/nostr/service.ts`

3개 앱에서 NIP-44 복호화 → ChatMessage 구성 → IDB 저장 로직이 80-95% 동일.

→ `shared/src/dispute-message.ts`로 공통 로직 추출.

### 7. sponsor localStorage 키 네이밍 통일

현재:
- customer: `customer:orders`
- sponsor: `nostr:orders` ← 비일관적
- admin: `admin:orders`

→ `sponsor:orders`로 변경. 마이그레이션 코드로 기존 데이터 이관.

---

## P2: 구조 개선 및 네이밍 통일

### 8. `OrderStateMeta` 인터페이스 통일

현재:
- customer: `DisplayMeta` 타입 + `getDisplayMeta()` 함수
- sponsor: `OrderStateMeta` 타입 + `getStateMeta()` 함수

→ shared에 `OrderStateMeta` 인터페이스 정의.
→ 함수명을 `getOrderStateMeta()`로 통일.
→ 앱별 라벨/색상 차이는 각 앱에서 메타 맵만 오버라이드.

### 9. `nostr/subscribe.ts` 공통 구독 함수 추출 (70% 동일)

kind 30402, kind 1111 구독 필터 구성이 3개 앱에서 거의 동일.

→ `shared/src/nostr/subscribe.ts`에 `subscribeKind30402()`, `subscribeKind1111()` 제네릭 함수 추출.
→ 각 앱은 콜백만 주입.

### 10. `components/ChatWindow.tsx` 기본 컴포넌트 추출 (customer↔sponsor 99% 동일)

admin만 `CommitmentBadge` 컴포넌트가 추가됨.

→ 기본 ChatWindow를 shared로 이동.
→ admin은 `CommitmentBadge`를 prop/slot으로 주입하여 확장.

### 11. `nostr/chat-subscribe.ts` customer↔sponsor 통합 (85% 동일)

customer와 sponsor는 NIP-44 복호화 로직이 거의 동일 (sk 직접 사용).
admin만 NIP-46 signer를 사용하여 비동기 래퍼 필요.

→ customer+sponsor 공통 로직을 shared로 추출.
→ admin은 별도 유지.

---

## P3: 장기 개선

### 12. `canTransition()` shared 이동

`admin/src/state-machine.ts`의 FSM 전이 규칙은 프로토콜 수준 정의.
shared로 이동하면 customer/sponsor에서도 상태 검증에 활용 가능.

### 13. `order-states.ts` 관심사 분리

`customer/src/order-states.ts`에 디스플레이 메타데이터(색상, 라벨)와
비즈니스 로직(`isDeletable()`, `isCancellable()`, `isFinal()`)이 혼재.

→ 디스플레이 메타: shared (8번과 연계)
→ 비즈니스 판단 로직: customer 전용 유틸로 분리

---

## 정리 대상에서 제외한 것들

분석 결과 현재 구조가 적절하여 변경하지 않는 항목:

| 파일 | 사유 |
|------|------|
| `types.ts` (3개 앱) | 각 앱의 도메인 모델이 근본적으로 다름 |
| `bolt11.ts` (customer↔sponsor) | 용도가 다름 (간단 디코딩 vs 상세 검증 vs 라우팅 힌트) |
| `nostr/service.ts` (전체) | admin 725줄 FSM 오케스트레이션 vs customer/sponsor 얇은 래퍼 |
| `order-store.ts` (3개 앱) | 반응형 패턴은 비슷하나 mutation 로직이 앱마다 다름 |
