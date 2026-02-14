# 사줘 트래커 시스템 아키텍처

## 개요

"사줘 트래커"는 쿠팡 무통장입금 주문을 추적하고, 다른 사람에게 대신 결제를 요청할 수 있는 시스템이다.
탈중앙화 통신 프로토콜인 **Nostr**를 통해 사용자 간 메시지를 주고받는다.

## 시스템 구성

```
┌─────────────────────────────────────────────────────────────────┐
│                         Nostr Network                           │
│                    (탈중앙화 릴레이 서버)                          │
└─────────────────────────────────────────────────────────────────┘
        ↑                    ↑                    ↑
        │                    │                    │
   ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
   │ Customer │          │ Sponsor │          │  Admin  │
   │   App    │          │   App   │          │   App   │
   └─────────┘          └─────────┘          └─────────┘
   Chrome Extension      React SPA            (미구현)
```

### 레포지토리 구조

```
sajwo-tracker/              ← pnpm workspace 루트
  pnpm-workspace.yaml
  package.json
  ARCHITECTURE.md
  PROTOCOL.md
  TODO.md
  shared/                   ← 3개 앱 공통 Nostr 모듈
  customer/                 ← 고객용 Chrome Extension
  sponsor/                  ← 후원자용 React SPA
  admin/                    ← 관리자용 앱 (미구현)
```

| 폴더 | 설명 | 형태 | 대상 사용자 |
|------|------|------|------------|
| `shared/` | Nostr 공통 모듈 (키, 릴레이, 상수, 타입) | TypeScript 라이브러리 | - |
| `customer/` | 사줘 요청을 보내는 고객용 앱 | Chrome Extension (MV3) | 물건을 사달라고 요청하는 사람 |
| `sponsor/` | 사줘 요청을 받고 결제하는 후원자용 앱 | React SPA | 대신 결제해주는 사람 |
| `admin/` | 시스템 관리자용 앱 | 미정 | 시스템 운영자 |

## Shared 패키지

Customer, Sponsor, Admin 세 앱이 공통으로 사용하는 Nostr 관련 코드를 `@sajwo-tracker/shared`로 추출했다.

### StorageAdapter 패턴

세 앱은 저장소 계층이 다르다:
- **Customer**: `chrome.storage.local` (Chrome Extension API, 객체를 직접 저장)
- **Sponsor/Admin**: `localStorage` (Web Storage API, JSON 직렬화 필요)

이 차이를 `StorageAdapter` 인터페이스로 추상화한다:

```typescript
interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}
```

각 앱은 자신의 저장소에 맞는 어댑터를 생성하여 shared 함수에 전달한다:
- Customer → `customer/src/nostr/storage.ts` (chrome.storage.local 어댑터)
- Sponsor → `sponsor/src/nostr/storage.ts` (`createWebStorage()` 사용)

### Shared 모듈 구조

```
shared/src/
  index.ts          - 재수출 (barrel)
  types.ts          - StorageAdapter, NostrKeypair, CachedRelayList
  constants.ts      - APP_PUBKEY, SAJWO_REQUEST_KIND, CLIENT_TAG, STORAGE_KEYS 등
  storage.ts        - createWebStorage() (localStorage 기반 어댑터 팩토리)
  keys.ts           - ensureKeypair(storage), getSecretKey(storage), getUserPubkey(storage)
  relays.ts         - getRelays(storage), refreshRelays(storage) (NIP-65 디스커버리)
```

패키지는 TypeScript 소스를 직접 export하며, 각 앱의 Vite가 빌드 시 컴파일한다.

## Nostr 프로토콜

### 왜 Nostr인가?

- **탈중앙화**: 중앙 서버 없이 릴레이를 통해 P2P 통신
- **검열 저항**: 특정 서버에 의존하지 않음
- **프라이버시**: 공개키 기반 암호화로 익명성 보장
- **확장성**: 다양한 릴레이 서버 활용 가능

### 통신 흐름

```
1. 주문 감지 (Customer)
   └─> 쿠팡 주문 상세 페이지에서 무통장입금 주문 감지

2. 사줘 요청 발송 (Customer → Nostr)
   └─> Nostr 이벤트로 사줘 요청 브로드캐스트

3. 요청 수신 (Sponsor)
   └─> 릴레이에서 사줘 요청 이벤트 구독

4. 클레임 응답 (Sponsor → Nostr)
   └─> "내가 사줄게" 응답 이벤트 발송

5. 선택 및 확정 (Customer)
   └─> 클레이머 중 한 명 선택, 계좌 정보 전달

6. 결제 완료 (Sponsor → 쿠팡)
   └─> 무통장입금 완료

7. 완료 확인 (Customer)
   └─> 쿠팡에서 입금 확인, 상태 업데이트
```

### 릴레이 모델 (NIP-65 Outbox)

```
                    앱 pubkey의 kind 10002에서 read relay 파싱
                                    │
                                    ▼
              ┌──────────────────────────────────────┐
              │         App의 Read Relays             │
              │  (wss://relay1.com, wss://relay2.com) │
              └──────────────────────────────────────┘
                    ▲                        │
                    │                        │
              Customer WRITE           Sponsor READ
              (사줘 요청 발행)          (사줘 요청 구독)
```

- Admin이 앱 pubkey의 kind 10002 이벤트를 업데이트하면 릴레이 목록이 변경된다.
- Customer/Sponsor 모두 10분마다 갱신하여 변경을 반영한다.
- 이벤트 프로토콜 상세는 [PROTOCOL.md](PROTOCOL.md) 참조.

### 사용 라이브러리

- **nostr-tools**: Nostr 프로토콜 구현 라이브러리
  - 버전: 2.23.0+
  - `nostr-tools/pure` (키 생성/서명), `nostr-tools/pool` (SimplePool)

## 각 앱별 역할

### Customer App (고객용)

Chrome Extension (Manifest V3)으로, 쿠팡 주문 페이지에서 동작한다.

- 쿠팡 주문 페이지 파싱 및 무통장입금 주문 감지 (+ 취소 감지)
- 주문 상태 관리 (상태 머신 기반, optimistic locking)
- Nostr를 통한 사줘 요청 발송 (kind 30402 NIP-99 Classified Listing)
- 팝업/대시보드에서 퍼블리시 버튼으로 수동 발행

#### Customer 모듈 구조

```
customer/src/
  background/index.ts   - Nostr 초기화, 릴레이 갱신 알람, 메시지 핸들러
  content/index.ts      - 쿠팡 페이지 파싱, 주문 감지
  nostr/
    storage.ts          - chrome.storage.local 기반 StorageAdapter
    constants.ts        - Customer 전용 상수 (알람 이름, 갱신 주기)
    events.ts           - 사줘 요청 이벤트 빌드 (NIP-33, NIP-40)
    publish.ts          - SimplePool 기반 브로드캐스트
  shared/
    types.ts            - TrackedOrder, 상태 전이 타입, 쿠팡 API 타입
    storage.ts          - chrome.storage.local 주문 CRUD
    state-machine.ts    - 상태 전이 (optimistic locking)
    filter.ts           - 쿠팡 데이터 파싱
  popup/                - 팝업 UI
  dashboard/            - 전체화면 대시보드 UI
```

### Sponsor App (후원자용)

React 19 + TypeScript SPA로, 별도 웹사이트에서 동작한다.

- Nostr에서 사줘 요청 실시간 구독 (SimplePool.subscribeMany)
- 오더북 형태로 활성 요청 목록 표시 (만료된 것 자동 필터링)
- localStorage에 주문 영구 캐시 (즉시 로드 후 백그라운드 동기화)
- sold 상태 이벤트 수신 시 주문 자동 삭제
- 남은 시간 매초 자동 갱신

#### Sponsor 데이터 흐름

```
Nostr 릴레이
    │
    ▼
nostr/service.ts  ── 구독, 이벤트 수신 ──→  order-store.ts  ←── localStorage
                                                │
                                          useSyncExternalStore
                                                │
                                                ▼
                                          OrderBook.tsx  →  OrderCard.tsx
```

구독 서비스(nostr/service.ts)가 릴레이에서 이벤트를 수신하면 반응형 스토어(order-store.ts)에 반영한다.
스토어는 localStorage에 영구 저장하면서 리스너에게 변경을 통지한다.
UI 컴포넌트는 `useSyncExternalStore`로 스토어를 구독하여 변경 즉시 리렌더한다.
구독 서비스와 UI가 분리되어 있으므로, 컴포넌트 마운트/언마운트와 무관하게 구독이 유지된다.

#### Sponsor 모듈 구조

```
sponsor/src/
  main.tsx              - React 엔트리
  App.tsx               - 레이아웃 (KeyInit → AppContent), 구독 서비스 시작
  types.ts              - SajwoRequest 타입, parseEvent()
  order-store.ts        - 반응형 주문 스토어 (localStorage + useSyncExternalStore)
  nostr/
    storage.ts          - createWebStorage() 싱글턴
    subscribe.ts        - SimplePool 구독 래퍼 (active/sold 분기)
    service.ts          - 구독 서비스 (릴레이 → order-store 연결)
  components/
    KeyInit.tsx         - 키페어 보장 래퍼 (투명하게 처리)
    OrderBook.tsx       - 오더북 (스토어 구독 + 1초 타이머)
    OrderCard.tsx       - 개별 요청 카드 (금액, 남은 시간 실시간 갱신)
```

### Admin App (관리자용)

미구현. 향후 시스템 모니터링, 릴레이 목록 관리 등을 담당할 예정.

## 기술 스택

| 영역 | Customer | Sponsor | Shared |
|------|----------|---------|--------|
| 언어 | TypeScript | TypeScript | TypeScript |
| 프레임워크 | Chrome Extension (MV3) | React 19 | - |
| 빌드 | Vite + CRXJS | Vite | (앱에서 컴파일) |
| 통신 | Nostr (nostr-tools) | Nostr (nostr-tools) | Nostr (nostr-tools) |
| 저장소 | chrome.storage.local | localStorage | StorageAdapter |
| 테스트 | Vitest | - | - |
| 패키지 관리 | pnpm workspace | pnpm workspace | pnpm workspace |

## 관련 문서

- [PROTOCOL.md](PROTOCOL.md) - Nostr 이벤트 프로토콜 명세 (3개 앱 공통)
- [TODO.md](TODO.md) - 향후 구현 계획
