# Customer 앱 마이그레이션 계획

> 상태: **아카이브 — 구현 완료** (Phase 1·2 모두 반영됨)
>
> 당시 계획 기록이다. 현행 구조는 [ARCHITECTURE.md](../ARCHITECTURE.md)가 진실이며,
> 특히 **2026-09-12 고객앱·후원자앱 통합** 이후로는 여기 서술된 앱 분리 구조가 더 이상 맞지 않는다.

Chrome 확장 프로그램 → 웹앱 (Phase 1) → 유저스크립트 연동 (Phase 2)

## 배경

Customer 앱은 현재 Chrome Extension(MV3)으로 구현되어 있으나 두 가지 근본적 문제가 있다.

### 1. Chrome Web Store 등록 불가

1. **쿠팡 내부 API 스크래핑**: `__NEXT_DATA__` 파싱 + Next.js 내부 JSON 엔드포인트 호출
2. **인증 세션으로 금융 데이터 추출**: `credentials: 'include'`로 쿠팡 세션 쿠키 이용
3. **암호화폐 관련 확장**: BTC 에스크로 거래 중개 → 구글의 극도로 엄격한 심사 기준
4. **자금세탁(AML) 우려**: 이커머스 구매 + P2P 크립토 거래 결합 구조
5. **host_permissions 정당화 불가**: `https://mc.coupang.com/*` 전체 접근 권한

### 2. MV3 서비스워커 생명주기 문제

- MV3 서비스워커는 **비활성 ~30초 후 종료**되며, Nostr 릴레이 WebSocket 구독이 함께 죽는다.
- Admin이 오더 상태를 갱신해도 Customer 앱이 이를 수신하지 못해 "요청대기" 상태에 멈춘다.
- 팝업을 열면 서비스워커가 깨어나 상태가 갱신되지만, 이는 근본적 해결이 아니다.
- `chrome.alarms` keep-alive를 구현할 수는 있으나 MV3의 설계 의도에 반하며 불안정하다.

## 마이그레이션 전략: 2단계 접근

### Phase 1: 수동 입력 웹앱 (최소 기능)

쿠팡 자동 파싱을 포기하고, **유저가 주문 정보를 직접 입력**하는 일반 웹앱을 먼저 만든다.
확장 프로그램의 모든 생명주기 문제에서 해방되며, 핵심 에스크로 흐름을 즉시 사용할 수 있다.

**범위:**
- Customer 웹앱 (React SPA, Sponsor/Admin 앱과 동일한 정적 배포)
- 유저가 주문 정보(가격, 만료일 등)를 수동 입력하여 사줘 요청 발행
- Admin 오더 상태 구독 + 로컬 저장소 반영 + 대시보드 UI
- 키 생성/관리
- 유저스크립트 불필요

### Phase 2: 유저스크립트 자동 파싱 연동

Phase 1 웹앱에 **Tampermonkey 유저스크립트를 연동**하여 쿠팡 주문 자동 파싱을 복원한다.
기술적 난이도가 높고, 유저스크립트 자체의 한계(Tampermonkey 설치 필요, 키 복사 등)도 있어
Phase 1에서 충분하다고 판단되면 Phase 2는 보류/폐기할 수 있다.

---

## Phase 1 상세: 수동 입력 웹앱

### 아키텍처

```
Customer 웹앱 (React SPA)
┌──────────────────────────────────────┐
│ 주문 수동 입력 폼                      │
│ → kind 1111 order-request 발행        │
│                                      │
│ 릴레이 구독 (Admin kind 30402)         │
│ → localStorage → 대시보드 UI           │
└──────────────────────────────────────┘
```

### UI

- **현재 확장 프로그램 대시보드(`customer/src/dashboard/`)와 동일한 룩앤필**
- Sponsor 앱 UI가 아닌 현재 Customer 대시보드의 디자인을 유지
- 뒷단 로직(릴레이 구독 → localStorage → UI)은 Sponsor 앱 패턴을 따름

### 코드 재사용

- `shared/`: 키 관리, 릴레이 디스커버리, 상수, 타입 전체
- `customer/src/nostr/events.ts`: kind 1111 이벤트 빌드 로직
- `customer/src/nostr/admin-orders.ts`: Admin 오더 구독 로직 (WebSocket 생명주기 문제 없는 웹앱 환경)
- `customer/src/dashboard/`: UI 구조 참고 (HTML/CSS 레이아웃)

---

## Phase 2 상세: 유저스크립트 자동 파싱 연동

### 아키텍처

```
유저스크립트 (쿠팡 페이지)              Customer 웹앱 (React SPA)
┌──────────────────────────┐           ┌──────────────────────────┐
│ 1. 쿠팡 주문 파싱          │           │ 릴레이 구독               │
│ 2. 릴레이 디스커버리        │           │  - Admin kind 30402      │
│    (DISCOVERY_RELAYS에서   │           │  - 유저스크립트 알림 수신   │
│     APP_PUBKEY의 10002    │           │    (kind 1111, #p=자기)   │
│     → 읽기 릴레이 확보)     │ ─릴레이─▶ │ → localStorage           │
│ 3. Nostr 키로 서명         │           │ → 대시보드 UI             │
│ 4. 읽기 릴레이에 발행       │           │                          │
│ (저장소 없음, UI 없음)      │           │ 유저스크립트 설치 가이드    │
└──────────────────────────┘           │ (코드블록 복사 제공)       │
                                       └──────────────────────────┘
```

### 유저스크립트 → 웹앱 통신: 새로운 알림 이벤트

유저스크립트가 발행하는 이벤트는 **기존 사줘 요청(order-request)과는 별도의 알림**이다.

- 쿠팡에서 무통장입금 주문이 파싱되었다는 사실을 고객 웹앱에만 알리는 용도
- Admin이 자동으로 오더를 생성하지 않는다 — **유저가 웹앱에서 사줘 요청 여부를 직접 결정**
- 이 알림은 고객 웹앱에서만 표시되며, Admin/Sponsor에는 전달되지 않는다

**이벤트 흐름:**
1. 유저스크립트: 쿠팡 무통장입금 주문 감지 → `action: 'parsed-order'` kind 1111 발행 (p 태그 = 자기 pubkey)
2. 고객 웹앱: kind 1111 구독 중 `#p = 자기 pubkey` 필터로 수신 → "새 주문이 감지되었습니다" 표시
3. 유저가 웹앱에서 해당 주문으로 사줘 요청을 할지 수동 결정
4. 사줘 요청 시 기존 `action: 'order-request'` kind 1111 발행 (p 태그 = APP_PUBKEY) → Admin이 수신

### 유저스크립트 상세

#### 실행 환경

- **Tampermonkey** (Chrome) / **Violentmonkey** (Firefox)
- 유저스크립트 포맷이 동일하므로 스크립트 하나로 양쪽 지원

#### 메타데이터

```javascript
// ==UserScript==
// @name         사줘 트래커 - 쿠팡 파서
// @match        https://mc.coupang.com/ssr/desktop/order/*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==
```

#### 기능

1. **쿠팡 주문 파싱**: `__NEXT_DATA__` → JSON API 호출 → 주문 데이터 추출
   - 최초 주문 감지: 무통장입금 대상 주문 식별 + 가상계좌 정보 추출
   - 결제 완료 감지: 입금 상태 변경 감지
   - 취소 감지: 주문 취소 상태 감지
2. **릴레이 디스커버리**: `DISCOVERY_RELAYS`(purplepag.es, relay.damus.io, nos.lol)에서 `APP_PUBKEY`의 kind 10002 조회 → 읽기 릴레이 확보
3. **Nostr 발행**: 파싱 결과를 kind 1111 이벤트로 서명 + 읽기 릴레이에 브로드캐스트
   - `action: 'parsed-order'` — 파싱된 주문 알림 (p 태그 = 자기 pubkey, 고객앱만 수신)
   - `action: 'payment-confirm'` — 입금 완료 (p 태그 = APP_PUBKEY, Admin이 수신)
   - `action: 'cancel-request'` — 주문 취소 (p 태그 = APP_PUBKEY, Admin이 수신)

#### 키 관리

- **GM_getValue/GM_setValue**: Tampermonkey 전용 영구 저장소 (유저 로컬 PC, 스크립트별 격리)
- **키 공유 흐름**:
  1. Customer 웹앱에서 키 자동 생성 + 설정 페이지에서 nsec 표시
  2. 사용자가 nsec를 복사하여 유저스크립트 최초 실행 시 1회 입력
  3. 이후 GM_storage에 영구 저장 → 매번 자동 로드

#### WebSocket 사용

- `@grant GM_getValue` 등을 선언하면 확장 컨텍스트에서 실행되므로 쿠팡 CSP 무관하게 WebSocket 사용 가능
- Nostr 릴레이 연결(wss://)에 제약 없음

### 고객 웹앱의 Phase 2 추가사항

#### 유저스크립트 알림 수신을 위한 추가 구독

- **kind 1111, `#p` = 자기 pubkey** 필터로 유저스크립트가 발행한 `parsed-order` 알림을 수신
- 기존 Admin 오더 구독(kind 30402, authors = APP_PUBKEY)과 별도로 운영
- 수신된 파싱 데이터를 "미확인 주문" 목록으로 표시 → 유저가 사줘 요청 여부 결정

#### 유저스크립트 설치 가이드

- 고객 웹앱 내에 유저스크립트 전문을 **코드블록으로 표시**하여 원클릭 복사 가능
- Tampermonkey 설치 → 스크립트 붙여넣기 → nsec 입력까지의 가이드 제공

---

## 모바일 대응

### 3개 앱 모바일 화면 대응

- Customer 웹앱, Sponsor 앱, Admin 앱 모두 모바일 반응형 UI 지원
- 모바일에서 대시보드 확인, 상태 추적, 기본 조작 가능

### 모바일 쿠팡 주문 파싱: 불가

- 모바일 브라우저: 확장 프로그램/유저스크립트 미지원 (Firefox Android 제외)
- 쿠팡 앱: 네이티브 앱 내부 데이터 접근 불가
- **결론**: 쿠팡 주문 파싱은 PC 전용. 모바일에서는 대시보드 확인 + 수동 입력만 가능.

---

## 마이그레이션 순서

### Phase 1 (즉시 실행)
1. Customer 웹앱 프로젝트 생성 (Vite + React 19, Sponsor 앱 구조 참고)
2. 키 생성/관리 (shared 패키지 재사용)
3. 릴레이 디스커버리 구독 (shared의 `subscribeRelayLists`)
4. Admin 오더 구독 (kind 30402, 기존 `admin-orders.ts` 로직 이관)
5. 주문 수동 입력 폼 + kind 1111 order-request 발행
6. 대시보드 UI (기존 Customer 대시보드 룩앤필)

### Phase 2 (Phase 1 완료 후, 선택적)
1. 유저스크립트 작성 (쿠팡 파싱 + 릴레이 디스커버리 + Nostr 발행)
2. 고객 웹앱에 유저스크립트 알림 구독 추가 (kind 1111, #p = 자기)
3. 미확인 주문 → 사줘 요청 전환 UI
4. 유저스크립트 설치 가이드 + 코드블록 복사 기능
5. 키 공유 흐름 구현 (웹앱 nsec 표시 → GM_storage)

### 기존 Chrome Extension
- 삭제하지 않고 유지 (최후의 수단으로 CRX 셀프 배포 가능성)

---

**Created**: 2025-02-22
**Updated**: 2026-02-22 — Phase 1/2 분리, MV3 생명주기 문제 추가, 유저스크립트 알림 이벤트 설계
