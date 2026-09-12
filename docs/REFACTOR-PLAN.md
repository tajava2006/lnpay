# 리팩터링 플랜

> 상태: **아카이브 — 완료**
>
> 당시 정리 기록이다. 이후 **2026-09-12 통합**으로 디렉토리 구조가 크게 바뀌었다
> (`customer/src/{buyer,sponsor,history,nostr}`). 현행은 [ARCHITECTURE.md](../ARCHITECTURE.md) 참조.

> 기능 변경 없이 코드 정리만 수행한다. 중복 제거, 네이밍 통일, 파일 위치 조정이 목표.

## P0: 100% 동일 코드 → shared 이동 ✅

### 1. `chat-store.ts` ✅

3개 앱 100% 동일(86줄) → `shared/src/chat-store.ts`로 통합.

### 2. `nostr/storage.ts` ✅

3개 앱 100% 동일 → `shared/src/storage.ts`에서 싱글턴 export, 각 앱의 `nostr/storage.ts` 삭제.

### 3. `components/BtcPrice.tsx` ✅

3개 앱 100% 동일 → `shared/src/components/BtcPrice.tsx`로 이동.

### 4. `components/KeyInit.tsx` ✅

customer↔sponsor 99% 동일 → `shared/src/components/KeyInit.tsx`로 이동.

---

## P1: 높은 중복률 코드 공통화 ✅

### 5. `idb-store.ts` 공통 함수 추출 ✅

P0.1 chat-store 통합 시 IDB 공통 함수도 함께 `shared/src/idb.ts`로 이동 완료.

### 6. `handleDisputeMessage()` 추출 ✅

3개 앱의 NIP-44 복호화 → ChatMessage → IDB 저장 로직을 `shared/src/dispute-message.ts`로 추출.
복호화 방식(sk 직접 vs NIP-46 signer)은 콜백으로 주입.

### 7. sponsor localStorage 키 네이밍 통일 ✅

`nostr:orders` → `sponsor:orders`로 변경. (customer: `customer:orders`, admin: `admin:orders`와 일관성 확보)

---

## P2: 구조 개선 및 네이밍 통일

### 8. `OrderStateMeta` 인터페이스 통일 — 스킵

메타맵의 라벨/색상이 앱마다 의도적으로 다르고, 함수 시그니처도 다름.
인터페이스 하나 공통화하는 건 오버엔지니어링.

### 9. `nostr/subscribe.ts` 공통 구독 함수 추출 — 스킵

필터 구성이 거의 동일하나, 각 함수가 15~20줄로 이미 얇은 래퍼.
공통화하면 shared → SimplePool 의존성이 추가되는데 이득이 적음.

### 10. `components/ChatWindow.tsx` 기본 컴포넌트 추출 ✅

3앱 동일 ChatWindow(197줄)를 `shared/src/components/ChatWindow.tsx`로 통합.
Admin 전용 CommitmentBadge는 `renderAccountExtra` prop으로 주입.

### 11. `nostr/chat-subscribe.ts` customer↔sponsor 통합 — 스킵

이미 얇은 래퍼이고, 9번과 같은 이유로 공통화 이득 미미.

---

## P3: 장기 개선

### 12. `canTransition()` shared 이동 — 스킵

프로토콜 수준 정의이긴 하나, 상태 전이 권한은 Admin 전용.
customer/sponsor는 Admin이 발행한 상태를 그대로 수용하므로 shared에 올려도 쓸 곳이 없음.

### 13. `order-states.ts` 관심사 분리 — 스킵

8번 스킵과 같은 맥락. 앱별 메타맵이 의도적으로 다르므로 현재 구조 유지.

---

## 정리 대상에서 제외한 것들

분석 결과 현재 구조가 적절하여 변경하지 않는 항목:

| 파일 | 사유 |
|------|------|
| `types.ts` (3개 앱) | 각 앱의 도메인 모델이 근본적으로 다름 |
| `bolt11.ts` (customer↔sponsor) | 용도가 다름 (간단 디코딩 vs 상세 검증 vs 라우팅 힌트) |
| `nostr/service.ts` (전체) | admin 725줄 FSM 오케스트레이션 vs customer/sponsor 얇은 래퍼 |
| `order-store.ts` (3개 앱) | 반응형 패턴은 비슷하나 mutation 로직이 앱마다 다름 |
