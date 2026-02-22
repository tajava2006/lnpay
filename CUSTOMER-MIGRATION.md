# Customer 앱 마이그레이션 계획

Chrome 확장 프로그램 → 유저스크립트 + 웹앱 분리

## 배경

Customer 앱은 현재 Chrome Extension(MV3)으로 구현되어 있으나,
Chrome Web Store 정식 등록이 사실상 불가능하다.

### 리젝 사유

1. **쿠팡 내부 API 스크래핑**: `__NEXT_DATA__` 파싱 + Next.js 내부 JSON 엔드포인트 호출
2. **인증 세션으로 금융 데이터 추출**: `credentials: 'include'`로 쿠팡 세션 쿠키 이용
3. **암호화폐 관련 확장**: BTC 에스크로 거래 중개 → 구글의 극도로 엄격한 심사 기준
4. **자금세탁(AML) 우려**: 이커머스 구매 + P2P 크립토 거래 결합 구조
5. **host_permissions 정당화 불가**: `https://mc.coupang.com/*` 전체 접근 권한

## 마이그레이션 아키텍처

### AS-IS (Chrome Extension)

```
content/index.ts (쿠팡 파싱) → chrome.storage.local → popup/dashboard (onChanged 리스너)
background/index.ts (Nostr 구독/발행) ← SEND_REQUEST 메시지 ← popup
```

### TO-BE (유저스크립트 + 웹앱)

```
유저스크립트 (쿠팡 페이지)              Customer 웹앱 (React SPA)
┌──────────────────────────┐           ┌──────────────────────────┐
│ 1. 쿠팡 파싱              │           │ 릴레이 구독               │
│ 2. Nostr 키로 서명        │ ─릴레이─▶ │ → localStorage           │
│ 3. 릴레이 발행            │           │ → 대시보드 UI             │
│ (저장소 없음, UI 없음)     │           │ (Sponsor앱과 동일 패턴)   │
└──────────────────────────┘           └──────────────────────────┘
```

### 핵심 원칙

- **유저스크립트**: 쿠팡 데이터 파싱 + Nostr 서명/발행만 담당. 저장소 로직 일절 없음.
- **Customer 웹앱**: 릴레이 구독으로 주문/요청 수신 → localStorage → UI. Sponsor 앱과 동일 패턴.
- **두 컴포넌트 간 통신은 오직 Nostr 릴레이를 통해서만 이루어진다.**

## 유저스크립트 상세

### 실행 환경

- **Tampermonkey** (Chrome 사용자 — 유일한 선택지)
- **Violentmonkey** (Firefox 사용자 — Chrome에서는 MV2 비활성화로 사용 불가)
- 유저스크립트 포맷이 동일하므로 스크립트 하나로 양쪽 지원

### 메타데이터

```javascript
// ==UserScript==
// @name         사줘 트래커 - 쿠팡 파서
// @match        https://mc.coupang.com/ssr/desktop/order/*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==
```

### 기능

1. **쿠팡 주문 파싱**: `__NEXT_DATA__` → JSON API 호출 → 주문 데이터 추출
   - 최초 주문 감지: 무통장입금 대상 주문 식별 + 가상계좌 정보 추출
   - 결제 완료 감지: 입금 상태 변경 감지
   - 취소 감지: 주문 취소 상태 감지
2. **릴레이 탐색**: Admin pubkey의 kind 10002 이벤트 조회 → 읽기 릴레이 확보
3. **Nostr 발행**: 파싱 결과를 kind 1111 이벤트로 서명 + 브로드캐스트
   - `action: 'order-request'` — 신규 주문
   - `action: 'payment-confirm'` — 입금 완료
   - `action: 'cancel-request'` — 주문 취소

### 키 관리

- **GM_getValue/GM_setValue**: Tampermonkey 전용 영구 저장소 (유저 로컬 PC, 스크립트별 격리)
- **키 공유 흐름**:
  1. Customer 웹앱에서 키 자동 생성 + 설정 페이지에서 nsec 표시
  2. 사용자가 nsec를 복사하여 유저스크립트 최초 실행 시 1회 입력
  3. 이후 GM_storage에 영구 저장 → 매번 자동 로드

### WebSocket 사용

- `@grant GM_getValue` 등을 선언하면 확장 컨텍스트에서 실행되므로 쿠팡 CSP 무관하게 WebSocket 사용 가능
- Nostr 릴레이 연결(wss://)에 제약 없음

## Customer 웹앱 상세

### 구조

Sponsor 앱과 동일한 패턴의 React SPA:

- Nostr 릴레이 구독 → localStorage → UI (저장소 구독 패턴 준수)
- 키 생성/관리 (nsec 표시 기능 포함)
- 대시보드: 주문 목록, 상태 추적, Admin 오더 상태 수신
- 배포: 정적 파일 배포 (Sponsor/Admin 앱과 동일)

### 기존 코드 재사용

- `shared/` 패키지: 키 관리, 릴레이, 상수, 타입 그대로 사용
- `customer/src/nostr/admin-orders.ts`: 릴레이 구독 로직 → 웹앱으로 이관
- `customer/src/nostr/events.ts`: 이벤트 빌드 로직 → 유저스크립트에서 재사용
- `customer/src/shared/filter.ts`: 쿠팡 파싱 로직 → 유저스크립트에서 재사용
- `customer/src/popup/`: 대시보드 UI → 웹앱 UI로 전환

## 모바일 대응

### 3개 앱 모바일 화면 대응

- Customer 웹앱, Sponsor 앱, Admin 앱 모두 모바일 반응형 UI 지원
- 모바일에서 대시보드 확인, 상태 추적, 기본 조작 가능

### 모바일 쿠팡 주문 파싱: 포기

- 모바일 브라우저: 확장 프로그램/유저스크립트 미지원 (Firefox Android 제외)
- 쿠팡 앱: 네이티브 앱 내부 데이터 접근 불가 (SSL pinning, 접근성 서비스 비현실적)
- **결론**: 쿠팡 주문 파싱은 PC 전용. 모바일에서는 Customer 웹앱으로 대시보드 확인만 가능.

## 마이그레이션 순서

1. 현재 Chrome Extension 구조로 기능 개발 완료
2. Customer 웹앱 생성 (Sponsor 앱 구조 참고)
3. 유저스크립트 작성 (content script 파싱 로직 + Nostr 발행 이식)
4. 키 공유 흐름 구현 (웹앱 nsec 표시 → 유저스크립트 GM_storage)
5. Chrome Extension 버전도 유지 (셀프 배포 / 개발자 모드용)

---

**Created**: 2025-02-22
