# 사줘 트래커 시스템 아키텍처

## 개요

"사줘 트래커"는 **비트코인으로 상품을 결제하고 싶은 사람**(Customer)과,
**거래소를 거치지 않고 비트코인을 P2P로 매수하고 싶은 사람**(Sponsor)을 이어주는 시스템이다.

### 핵심 거래 구조

```
Customer                     Admin (에스크로)              Sponsor
(BTC로 물건 사고 싶음)        (거래 보증)                 (BTC를 사고 싶음)
     │                            │                         │
     │  ① 사줘 요청 발행           │                         │
     │ ──────────────────────────→│──────────────────────→  │
     │                            │                         │
     │                            │  ② 클레임 (+invoice)     │
     │                            │ ←────────────────────── │
     │                            │                         │
     │                            │  ③ probing (유동성 검증)  │
     │                            │                         │
     │  ④ 클레임 승인 전달          │                         │
     │ ←────────────────────────  │                         │
     │                            │                         │
     │  ⑤ BTC 에스크로 예치        │                         │
     │     (hold invoice 결제)    │                         │
     │ ──────────────────────────→│                         │
     │                            │                         │
     │                            │  ⑥ 계좌 정보 전달         │
     │                            │ ─────────────────────→  │
     │                            │                         │
     │                            │  ⑦ KRW 무통장입금         │
     │                            │           ──────────→ 쿠팡
     │                            │                         │
     │                            │  ⑧ settle → BTC 수령     │
     │                            │     → Sponsor에 BTC 전송 │
     │                            │ ─────────────────────→  │
```

- Customer는 쿠팡 상품을 비트코인으로 결제하는 효과를 얻는다.
- Sponsor는 거래소 없이 KRW → BTC 환전을 한다 (무통장입금 대행의 대가로 BTC 수령).
- Admin이 hold invoice로 BTC를 에스크로 보관하여 양측의 거래를 보증한다.
- 양측 간 통신은 탈중앙화 프로토콜인 **Nostr**를 통해 이루어진다.

### Admin의 에스크로 역할

거래의 안전성을 보장하기 위해 **Admin이 에스크로 서비스**를 제공한다.

Sponsor가 클레임을 보내면 이것이 바로 Customer에게 전달되지 않는다.
먼저 Admin이 해당 Sponsor의 **Lightning 인바운드 유동성**을 검증한다.
Lightning Network 특성상 수신 용량(inbound liquidity)이 부족하면 BTC를 받을 수 없으므로,
유동성이 확인된 Sponsor의 클레임만 Customer에게 전달한다.

```
Sponsor ──클레임(+invoice)──→ Admin ──probing──→ Customer
                                │
                        (경로/유동성 부족 시 거절)
```

**유동성 검증 방법**: Sponsor가 클레임 시 주문 금액에 해당하는 Lightning invoice를 제출한다.
Admin은 랜덤 payment hash로 probing을 수행하여 경로+유동성을 확인한다 (실제 결제 없음, 수수료 없음).

**에스크로 보관**: 유동성 검증 통과 후, Sponsor가 KRW를 먼저 입금해야 하므로
Customer의 BTC를 Admin이 **hold invoice**로 에스크로 보관한다.
KRW 입금이 확인되면 settle하여 BTC를 수령하고 Sponsor에게 전송한다.
문제 발생 시 settle하지 않으면 CLTV timeout 후 Customer에게 자동 환불된다.

```
① Probing (유동성 검증):  Admin ──랜덤hash──→ Sponsor   수신자 제어 = 문제 → probing으로 해결
② Escrow (BTC 수금):     Customer ──pay──→ Admin      수신자 제어 = 필요한 것 → hold invoice
```

상세 스펙은 [PROTOCOL.md](PROTOCOL.md) 참조.

에스크로 거래이므로 상태 전이의 정확성이 중요하며, Admin이 유일한 FSM과 상태 소유권을 갖는다.

## 시스템 구성

```
┌─────────────────────────────────────────────────────────────────┐
│                         Nostr Network                           │
│                    (탈중앙화 릴레이 서버)                          │
└─────────────────────────────────────────────────────────────────┘
        ↑                                         ↑
        │                                         │
   ┌────┴──────────────┐                    ┌─────┴───┐
   │   통합 유저 앱     │                    │  Admin  │
   │  내 주문 / 주문 찾기 │                    │   App   │
   │      / 내역        │                    └─────────┘
   └───────────────────┘                     React SPA
   React SPA + 유저스크립트              (에스크로 + LN 노드 제어)
   (양쪽 역할을 한 키로)
```

> **2026-09-12 통합**: 고객앱과 후원자앱을 하나로 합쳤다. 두 앱은 구독 필터가
> 문자 그대로 같았고(30402 authors=APP / 1111 #p=me), 오리진이 달라 키가 갈리는
> 것이 유일한 실질적 차이였다. 합치면서 한 키가 두 역할을 겸하게 되어
> **자기 주문 자기 클레임 금지**가 Admin FSM에 추가됐다 — 이 가드가 있어야
> "내가 어느 역할로 참여했는가"를 pubkey 비교로 유도할 수 있다.
>
> 구 후원자 도메인(`sponsor.`)은 정적 리다이렉트 껍데기만 남는다. 키는 오리진별
> localStorage에 묶여 있어 따라가지 않으므로, 구 후원자 사용자는 새 키를 받고
> 이전 내역을 잃는다(전환 시점 미완결 주문 0건을 릴레이에서 확인한 뒤 진행).

### 레포지토리 구조

```
sajwo-tracker/              ← pnpm workspace 루트
  pnpm-workspace.yaml
  package.json
  ARCHITECTURE.md
  PROTOCOL.md
  TODO.md
  shared/                   ← 공통 Nostr 모듈 + 공용 컴포넌트
  customer/                 ← 통합 유저 앱 (React 19 SPA)
    src/buyer/              ←   고객 역할 (내 주문)
    src/sponsor/            ←   후원자 역할 (주문 찾기)
    src/history/            ←   내역 (역할 유도 + 필터)
    src/nostr/              ←   통합 구독 (소켓 한 벌) + 역할별 팬아웃
    userscript/             ←   쿠팡 자동파싱 유저스크립트
  sponsor/                  ← 정적 리다이렉트 껍데기 (구 도메인용)
  admin/                    ← Admin 에스크로 서비스 (순수 프론트엔드)
```

> 패키지 이름 `customer/`와 IndexedDB 이름 `customer-history`는 역사적 잔재다.
> 통합 시 고객앱 쪽을 살렸고(유저스크립트가 그 키에 묶여 있었다), DB에는 만료
> 없는 분쟁 채팅이 쌓여 있어 이름을 바꾸려면 복사 마이그레이션이 필요했다.
> 이름값 하나 때문에 마이그레이션을 도입하지 않았다.

| 폴더 | 설명 | 형태 | 대상 사용자 |
|------|------|------|------------|
| `shared/` | Nostr 공통 모듈 (키, 릴레이, 상수, 타입) | TypeScript 라이브러리 | - |
| `customer/` | 통합 유저 앱 — 주문 등록·발행(고객) + 오더북·클레임(후원자) + 내역 | React 19 SPA | 일반 사용자 (한 키로 양쪽 역할) |
| `customer/userscript/` | 쿠팡 무통장입금 자동 감지 + Nostr 발행 | esbuild IIFE (Tampermonkey) | (통합 앱과 동일 키) |
| `sponsor/` | 구 후원자 도메인 → 통합 앱 안내/리다이렉트 | 정적 HTML | (전환 안내용) |
| `admin/` | 에스크로 (유동성 검증, 중재) | React SPA (순수 프론트엔드) | 시스템 운영자 |

## Shared 패키지

Customer, Sponsor, Admin 세 앱이 공통으로 사용하는 Nostr 관련 코드를 `@sajwo-tracker/shared`로 추출했다.

### StorageAdapter 패턴

3개 앱 모두 `localStorage`를 사용하지만, `StorageAdapter` 인터페이스로 추상화하여
shared 함수가 저장소 구현에 의존하지 않도록 한다:

```typescript
interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}
```

각 앱은 `createWebStorage(prefix)`로 어댑터를 생성하여 shared 함수에 전달한다.

### Shared 모듈 구조

```
shared/src/
  index.ts          - 재수출 (barrel)
  types.ts          - StorageAdapter, NostrKeypair, CachedRelayList
  constants.ts      - APP_PUBKEY, SAJWO_REQUEST_KIND, CLIENT_TAG, STORAGE_KEYS 등
  storage.ts        - createWebStorage() (localStorage 기반 어댑터 팩토리)
  keys.ts           - ensureKeypair(storage), getSecretKey(storage), getUserPubkey(storage)
  relays.ts         - getReadRelays, getWriteRelays, refreshRelayLists (NIP-65 디스커버리)
```

패키지는 TypeScript 소스를 직접 export하며, 각 앱의 Vite가 빌드 시 컴파일한다.

## Nostr 프로토콜

### 왜 Nostr인가?

- **탈중앙화**: 중앙 서버 없이 릴레이를 통해 P2P 통신
- **검열 저항**: 특정 서버에 의존하지 않음
- **프라이버시**: 공개키 기반 암호화로 익명성 보장
- **확장성**: 다양한 릴레이 서버 활용 가능

### 거래 흐름

```
1. 주문 감지 (Customer)
   └─> 쿠팡 주문 상세 페이지에서 무통장입금 주문 감지

2. 사줘 요청 발행 (Customer → Nostr)
   └─> kind 30402 이벤트로 사줘 요청 브로드캐스트 (status: active)

3. Fidelity bond 예치 (Customer → Admin)
   └─> Admin이 주문 금액 일부의 hold invoice 생성 (스팸 차단 목적)
   └─> Customer가 결제 → BTC 잠김, 오더북에 노출됨
   └─> BTC 없는 스패머는 원천 차단

4. 오더북 표시 (Sponsor)
   └─> 릴레이에서 사줘 요청 이벤트 실시간 구독, 오더북에 표시

5. 클레임 (Sponsor → Admin)
   └─> "내가 사줄게" 클레임 이벤트 발송
   └─> Admin이 수신하여 Sponsor의 Lightning 인바운드 유동성 검증
   └─> 블랙리스트 노드의 클레임은 자동 거절

6. 클레임 승인 (Admin → Customer)
   └─> 유동성 검증 통과 시 Customer에게 클레임 전달
   └─> 실패 시 Sponsor에게 거절 통보

7. 후원자 선택 (Customer)
   └─> 승인된 클레이머 중 한 명 선택

8. 에스크로 전환 (Fidelity bond → 본 결제)
   └─> Admin이 fidelity bond hold invoice cancel (BTC 즉시 반환)
   └─> 해당 시점의 정확한 BTC/KRW 환율로 본 hold invoice 생성
   └─> Customer가 본 hold invoice 결제 → BTC가 HTLC에 잠김

9. 무통장입금 (Sponsor → 쿠팡)
   └─> Admin이 Sponsor에게 계좌 정보 전달
   └─> Sponsor가 Customer의 쿠팡 주문에 무통장입금 (KRW)

10. BTC 릴리스 (Admin → Sponsor)
    └─> KRW 입금 컨펌 시 Admin이 hold invoice settle → BTC 수령
    └─> Admin이 Sponsor에게 BTC 전송 (Lightning)
    └─> 문제 발생 시: settle 안 함 → CLTV timeout 후 Customer에게 자동 환불

11. 완료 (Customer)
    └─> 쿠팡에서 입금 컨펌, Nostr에 sold 이벤트 재발행
```

### 릴레이 모델 (NIP-65 Outbox)

앱 pubkey의 kind 10002 이벤트에서 **읽기 릴레이**와 **쓰기 릴레이**를 분리 파싱한다.
이벤트 성격에 따라 사용 릴레이가 결정된다:

```
          kind 10002 ──→ 읽기 릴레이 / 쓰기 릴레이 분리

  ┌── 읽기 릴레이 ──────────────────────────────────────┐
  │  ① 비즈니스 이벤트 (주문·클레임)                      │
  │  Customer WRITE ──→ relay ──→ Sponsor/Admin READ    │
  └─────────────────────────────────────────────────────┘

  ┌── 쓰기 릴레이 ──────────────────────────────────────┐
  │  ② Admin 전용 데이터 (LN 설정 등)                     │
  │  Admin WRITE ──→ relay ──→ Admin READ               │
  │                                                     │
  │  ③ Admin→User 알림 (미구현)                           │
  │  Admin WRITE ──→ relay ──→ Customer/Sponsor READ    │
  └─────────────────────────────────────────────────────┘
```

- Admin이 앱 pubkey의 kind 10002 이벤트를 업데이트하면 릴레이 목록이 변경된다.
- 모든 앱이 10분마다 갱신하여 변경을 반영한다.
- 릴레이 선택 기준 상세는 [PROTOCOL.md](PROTOCOL.md) 참조.

### 사용 라이브러리

- **nostr-tools**: Nostr 프로토콜 구현 라이브러리
  - 버전: 2.23.0+
  - `nostr-tools/pure` (키 생성/서명), `nostr-tools/pool` (SimplePool)

## 각 앱별 역할

### Customer App

비트코인으로 물건을 사고 싶은 사람이 사용하는 React 19 SPA.
수동 입력 또는 유저스크립트 자동 파싱으로 주문을 생성하여 사줘 요청을 발행한다.

> 초기에는 Chrome Extension으로 구현했으나, Chrome Web Store 등록 불가(쿠팡 API 스크래핑,
> 암호화폐 관련 확장)와 MV3 서비스워커 생명주기 문제(~30초 후 종료 → WebSocket 구독 단절)로
> React SPA + Tampermonkey 유저스크립트 조합으로 전환했다.

- kind 1111로 Admin에 요청 전송 (order-request, payment-confirm, cancel-request, account-info, dispute-message)
- Admin의 kind 30402 오더 구독으로 상태 자동 반영 (로컬 FSM 없음)
- kind 1111 구독으로 유저스크립트가 발행한 parsed-order + dispute-message 수신 (#p=자기 pubkey)
- 대시보드에서 수동 입력 또는 감지된 주문으로 사줘 요청 발행
- 파싱 주문(source='parsed')은 계좌정보 편집 불가, escrowed 시 자동 전달
- NIP-44 암호화 계좌정보를 Sponsor에게 직접 전달 (SHA-256 commitment 포함)
- IndexedDB에 분쟁 채팅 + **내가 고객으로 관여한 오더** 영구 보존 (표시용 사본은 localStorage, 만료 시 삭제)

#### Customer 데이터 흐름

```
유저스크립트 (쿠팡 페이지)                  Customer 웹앱
┌──────────────────────────┐           ┌──────────────────────────┐
│ 쿠팡 __NEXT_DATA__ 파싱    │           │                          │
│ kind 1111 발행:           │  릴레이   │  kind 30402 구독 (Admin)  │
│   parsed-order (#p=self)  ├─────────→│  kind 1111 구독 (#p=self) │
│   payment-confirm         │           │  → order-store (localStorage)
│   cancel-request          │           │  → parsed-store (localStorage)
│ GM_storage 키 관리         │           │  → 대시보드 UI             │
└──────────────────────────┘           └──────────────────────────┘
```

#### Customer 모듈 구조

```
customer/src/
  main.tsx              - React 엔트리
  App.tsx               - 레이아웃 (KeyInit → AppContent), 구독 서비스 시작
  types.ts              - CustomerOrder, ParsedOrderPayload, Admin 이벤트 파서
  order-store.ts        - 반응형 주문 스토어 (localStorage + useSyncExternalStore)
  parsed-store.ts       - 파싱 주문 스토어 (유저스크립트 감지 주문, 요청 전 대기)
  chat-store.ts         - 분쟁 채팅 스토어 (인메모리, useSyncExternalStore)
  idb-store.ts          - IndexedDB 저장소 (분쟁 채팅 메시지 영구 보존)
  order-states.ts       - 주문 상태별 표시 메타 (라벨, 색상)
  nostr/
    storage.ts          - createWebStorage() 싱글턴
    subscribe.ts        - SimplePool 구독 (kind 30402 + kind 1111 유저스크립트)
    service.ts          - 구독 오케스트레이터 (Admin + 유저스크립트 + auto account-info + dispute-message IDB 저장)
    publish.ts          - 이벤트 발행 (order-request, notification, account-info, dispute-message)
    chat-subscribe.ts   - 분쟁 채팅 on-demand 구독 (디테일 페이지용)
  components/
    KeyInit.tsx         - 키페어 보장 래퍼
    Dashboard.tsx       - 메인 대시보드 (ParsedOrders + OrderForm + OrderTable + Guide)
    OrderForm.tsx       - 주문 수동 입력 폼
    OrderTable.tsx      - 주문 목록 테이블
    OrderRow.tsx        - 개별 주문 행 (계좌정보 잠금 로직 포함)
    OrderDetail.tsx     - 오더 상세 + 분쟁 채팅창
    ChatWindow.tsx      - 채팅 UI
    ParsedOrdersSection.tsx - 유저스크립트 감지 주문 목록 (사줘 요청/무시)
    InvoiceModal.tsx    - hold invoice QR 표시 + 결제
    AccountInfoModal.tsx - 수동 주문 계좌정보 입력
    KeyExport.tsx       - nsec 내보내기 (유저스크립트 키 공유)
    UserscriptGuide.tsx - 유저스크립트 설치 가이드 + 코드블록 복사

customer/userscript/       - Tampermonkey 유저스크립트 (esbuild IIFE 번들)
  banner.txt              - 메타데이터 헤더
  esbuild.config.mjs      - 빌드 설정 (dev/prod 지원)
  src/
    main.ts              - 엔트리 (주문 감지 → 발행 → 상태 변화 추적)
    coupang.ts           - 쿠팡 파싱 (__NEXT_DATA__, JSON API, 가상계좌 추출)
    nostr.ts             - 경량 Nostr (raw WebSocket, shared/constants 참조)
    storage.ts           - GM_storage 래퍼 (nsec, 처리 이력, 릴레이 캐시)
```

### Sponsor App

거래소를 거치지 않고 비트코인을 사고 싶은 사람이 사용하는 React 19 + TypeScript SPA.
무통장입금을 대행해주고 그 대가로 BTC를 수령한다.

- Nostr에서 사줘 요청 실시간 구독 (SimplePool.subscribeMany)
- kind 1111 구독으로 Customer → Sponsor 계좌정보 수신 (#p 필터, NIP-44 복호화)
- 오더북 형태로 활성 요청 목록 표시 (만료 임박순 정렬, 만료된 것 자동 필터링)
- localStorage에 주문 영구 캐시 (즉시 로드 후 백그라운드 동기화)
- IndexedDB에 클레임한 오더 + 관련 request + 분쟁 채팅 메시지 영구 보존 (Admin IDB 패턴 동일)
- sold 상태 이벤트 수신 시 주문 자동 삭제
- 남은 시간 매초 자동 갱신
- pubkey 기반 이벤트 검증 (같은 orderId라도 최초 발행자만 갱신/삭제 가능)

#### Sponsor 데이터 흐름

```
Nostr 릴레이
    │
    ├── kind 30402 ──→ nostr/service.ts ──→ order-store.ts ←── localStorage
    │                        │                    │
    │                        │ (IDB에 있으면)      │
    │                        └──→ idb-store.ts ←── IndexedDB
    │
    └── kind 1111 ──→ nostr/service.ts
                           │
                           ├── account-info ──→ NIP-44 복호화 ──→ account-store.ts
                           │                                          │
                           │                   idb-store.ts ←─────────┘
                           │                   (request 저장)
                           │
                           └── dispute-message ──→ NIP-44 복호화 ──→ idb-store.ts
                                                                    (messages 저장)
                                                             useSyncExternalStore
                                                                   │
                                                                   ▼
                                                      OrderBook.tsx → OrderCard.tsx
```

구독 서비스(nostr/service.ts)가 릴레이에서 이벤트를 수신하면 반응형 스토어에 반영한다.
kind 30402는 order-store(localStorage), kind 1111 account-info는 account-store(메모리)에 저장.
클레임한 오더는 IndexedDB에도 동기화하여 영구 보존한다.
UI 컴포넌트는 `useSyncExternalStore`로 스토어를 구독하여 변경 즉시 리렌더한다.
구독 서비스와 UI가 분리되어 있으므로, 컴포넌트 마운트/언마운트와 무관하게 구독이 유지된다.

#### Sponsor 모듈 구조

```
sponsor/src/
  main.tsx              - React 엔트리
  App.tsx               - 레이아웃 (KeyInit → AppContent), 구독 서비스 시작
  types.ts              - Order 파싱, SponsorRequest, AccountInfoEvent 타입
  order-store.ts        - 반응형 주문 스토어 (localStorage + useSyncExternalStore)
  account-store.ts      - 반응형 계좌정보 스토어 (메모리, UI 연동용)
  chat-store.ts         - 분쟁 채팅 스토어 (인메모리, useSyncExternalStore)
  idb-store.ts          - IndexedDB 영구 저장소 (오더 + request + 채팅 메시지 보존)
  nostr/
    storage.ts          - createWebStorage() 싱글턴
    subscribe.ts        - SimplePool 구독 래퍼 (kind 30402 + kind 1111)
    service.ts          - 구독 서비스 (릴레이 → store 연결, NIP-44 복호화, IDB 동기화)
    claim.ts            - 클레임 발행 + IDB 이관, 송금 완료(remit-request) + dispute-message 발행
    chat-subscribe.ts   - 분쟁 채팅 on-demand 구독 (디테일 페이지용)
  components/
    KeyInit.tsx         - 키페어 보장 래퍼 (투명하게 처리)
    OrderBook.tsx       - 오더북 (스토어 구독 + 1초 타이머)
    OrderCard.tsx       - 개별 요청 카드 (계좌정보 표시, 송금 완료 버튼)
    HistoryPage.tsx     - 히스토리 목록 (IDB 기반 거래 이력)
    OrderDetail.tsx     - 오더 상세 + 분쟁 채팅창 + 계좌정보 공개 버튼
    ChatWindow.tsx      - 채팅 UI
```

### Admin App

에스크로 서비스 제공자. 거래의 안전성을 보장하는 핵심 역할.

#### 배포 모델: 순수 프론트엔드 SPA

3개 앱 모두 **순수 프론트엔드**로 배포한다. Admin도 예외가 아니다.
별도의 백엔드 서버 없이 정적 파일만 배포하여 어디서든 접속 가능하다.

**인증 및 설정 관리 (NIP-46 + 암호화된 릴레이 저장소):**

1. **NIP-46 (Nostr Connect)**: Admin의 개인키를 앱에 직접 입력하지 않는다.
   NIP-46 프로토콜을 통해 원격 서명자(nsecBunker 등)에 인증을 위임하여
   개인키가 브라우저 환경에 노출되지 않는다.

2. **암호화된 릴레이 설정 저장소**: Lightning 노드 연결 정보(URL, 인증정보, 구현체 종류)를
   Nostr 릴레이에 암호화하여 저장한다.
   앱 시작 시 NIP-46으로 인증 후 릴레이에서 암호화된 설정을 불러와
   메모리(React 상태)에서만 유지한다.
   이로써 모든 `.env` 환경변수 의존성을 제거하고 프로덕션 빌드에 민감 정보가 포함되지 않는다.

```
NIP-46 인증 → 릴레이에서 암호화된 설정 복호화 → 메모리에 LN 연결 정보 보유
                                                    ↓
                                            브라우저 → (HTTPS) → LN 노드
```

**Lightning 노드 TLS 문제 해결:**

Lightning 노드는 자체 서명(self-signed) TLS 인증서를 사용하므로 브라우저가 직접 연결을 차단한다.
이를 해결하기 위해 **nginx 리버스 프록시**를 LN 노드 앞에 배치한다:

```
브라우저 ──(HTTPS/Let's Encrypt)──→ nginx ──(HTTPS/self-signed)──→ LN 노드 REST
```

- 브라우저 ↔ nginx: Let's Encrypt CA 인증서 (브라우저가 신뢰)
- nginx ↔ LN 노드: self-signed TLS (`proxy_ssl_verify off`, 같은 서버 내 localhost)
- nginx에서 CORS 헤더 추가 (`Access-Control-Allow-Origin` 등)
- 두 구간은 독립된 TLS 체인이므로 MITM 문제 없음

이 방식으로 탈중앙성은 약간 희생되지만 (CA 인증서가 필요한 도메인),
어차피 모든 앱이 정식 도메인으로 배포되어야 하므로 실질적인 추가 비용은 없다.

#### Lightning 노드 어댑터 패턴

LND와 CLN 어느 구현체든 대응할 수 있도록 `LightningAdapter` 인터페이스를 분리한다.

```typescript
interface LightningAdapter {
  getInfo(): Promise<NodeInfo>;
  decodeInvoice(bolt11: string): Promise<DecodedInvoice>;
  probe(destination, amountSat, finalCltvDelta?, routeHints?): Promise<ProbeResult>;
  createHoldInvoice(orderId, amountSat, expiry?): Promise<HoldInvoiceResult>;
  lookupHoldInvoice(paymentHash): Promise<HoldInvoiceStatus>;
}
```

브라우저에서 직접 LN 노드 REST API를 호출한다 (nginx 리버스 프록시 경유).
각 어댑터는 REST 요청 형식과 응답 매핑을 담당한다:

| 구현체 | getInfo | 인증 헤더 |
|--------|---------|----------|
| **LND** | `GET /v1/getinfo` | `Grpc-Metadata-macaroon: <hex>` |
| **CLN** (clnrest) | `POST /v1/getinfo` | `Rune: <string>` |

| 구현체 | probing 방법 |
|--------|------------|
| **LND** | REST `/v2/router/send` + 랜덤 payment hash |
| **CLN** | REST `getroute` + `sendpay`/`waitsendpay` 조합 |

LN 설정 미존재 시 Lightning 기능이 비활성화되고 기존 클레임 조회 기능만 동작한다 (graceful degradation).

**핵심 기능:**
- **클레임 대기열**: kind 1111 클레임 + kind 30402 주문 구독, 승인/거절 UI
- **Lightning 노드 연결**: LND/CLN 어댑터를 통한 노드 상태 확인 (30초 polling)
- **클레임 유동성 검증**: Sponsor의 invoice에 대해 랜덤 payment hash로 probing 수행
  - `INCORRECT_PAYMENT_DETAILS`: 경로 도달 + 유동성 존재 확인 → 승인 가능
  - `NO_ROUTE`, `TIMEOUT` 등: 유동성 부족 → 거절
- **BOLT-11 인보이스 디코딩**: `bolt11` 패키지로 destination, amount, route hints 추출
- **BTC/KRW 실시간 가격**: 업비트/빗썸/코인원 WebSocket

#### Hold Invoice 정산 시나리오 (settleInvoice)

Hold invoice의 settle은 프리이미지를 LN 노드에 제출하여 Customer의 BTC를 Admin이 수령하는 행위다.
settle이 발동하는 시나리오는 4가지이다.

**① 정상 완료 (payment-confirm)**

Customer의 쿠팡 자동 감지가 입금 완료를 확인하여 `payment-confirm` 요청을 보낸 경우.
`handlePaymentConfirm`에서 `escrowed`/`remitted` → `paid` 전이 후 `settleInvoice`를 호출한다.
쿠팡 데이터 기반 자동 감지이므로 이의 여지가 없는 확정 트리거다.

**② Sponsor 미입금 만료 (escrowed + 만료)**

`escrowed` 상태에서 Sponsor가 KRW를 보내지 않고(또는 `remitted` 요청을 보내지 않고) 만료된 경우.
Admin이 아무 동작도 하지 않으면 hold invoice의 CLTV가 타임아웃되어 BTC가 Customer에게 자동 환불된다.
`invoice-watcher`가 `cancelled` 상태를 감지하여 `escrowed → cancelled` 전이한다.
KRW를 보내놓고 `remitted` 요청을 안 보낸 경우는 Sponsor 과실로 간주한다.

**③ 분쟁 판정 — 만료 전 (remitted + Admin 판정)**

`remitted` 상태에서 만료 전에 Admin이 증거를 검토하여 판정한 경우:
- **sponsor_wins**: `settleInvoice` → BTC 수령 → Sponsor에게 BTC 전송. 상태: `remitted → sponsor_wins`.
- **customer_wins**: hold invoice cancel → BTC가 Customer에게 자동 환불. 상태: `remitted → customer_wins`.

이것이 가장 바람직한 분쟁 해결 경로다.

**④ 분쟁 안전망 — 만료 임박 시 선제 settle (remitted + 만료 임박)**

`remitted` 상태에서 Admin이 만료 전까지 판정하지 못한 경우.
hold invoice가 만료되면 BTC는 Customer에게 돌아가며 회수가 불가능하다.
Sponsor가 실제로 KRW를 보냈다면 영구 손실이 발생한다.

따라서 **만료 임박 시 `invoice-watcher`가 자동으로 settle**하여 BTC를 Admin 노드에 확보한다.
settle 후에도 Admin은 여전히 판정할 수 있다:
- **sponsor_wins**: Sponsor에게 BTC 전송 (정상 흐름과 동일).
- **customer_wins**: **별도의 LN 결제**로 Customer에게 BTC를 반환한다
  (hold invoice는 이미 settle되었으므로 cancel 불가).

비대칭 손실 원칙: settle하면 선택권이 남고, 만료되면 회수가 불가하므로 settle이 안전한 선택이다.

> **설계 원칙**: `cleanup.ts`는 만료 시 **상태 무관**하게 삭제한다 (remitted 포함).
> 자동 settle은 만료 10분 전에 발동하므로 cleanup과 충돌하지 않는다.
> 자동 settle 실패 + 만료 시: BTC는 Customer에게 자동 환불되고, Admin이 IndexedDB에서 확인 후 수동 판정한다.
> 시스템이 자동으로 `customer_wins`를 판정하지 않는다 — 판정은 반드시 Admin의 몫이다.

#### 분쟁 중재 (Dispute Mediation)

`remitted` 상태에서 Customer가 입금 컨펌을 하지 않으면, Admin이 양쪽과 각각 1:1 채팅으로 대화하고 증거를 검토한 뒤 `sponsor_wins` 또는 `customer_wins`를 판정한다.

**채팅 전송**: kind 1111 `dispute-message` + NIP-44 암호화.
기존 요청 이벤트 인프라를 재사용하여 NIP-17(gift wrap) 없이 구현한다.
Admin의 BunkerSigner가 NIP-44를 완벽히 지원하고, `a` 태그로 orderId 필터링이 가능하다.
상세 스펙은 [PROTOCOL.md](PROTOCOL.md)의 dispute-message 섹션 참조.

**채팅 저장**: IndexedDB + 릴레이 하이브리드.
메인 구독(kind 1111)으로 수신한 dispute-message를 NIP-44 복호화하여 IDB `messages` 스토어에 fire-and-forget 저장한다.
다른 요청 이벤트(order-request, claim 등)와 달리 localStorage에는 저장하지 않는다 — 디테일 페이지의 인메모리 chat-store + IDB만 사용한다.
이로써 expiration 태그 없이도 localStorage 데이터 비대화 문제가 발생하지 않으며, 증거를 영구 보존할 수 있다.

**채팅 UI**: 디테일 페이지 진입 시 IDB에서 기존 메시지 즉시 로드 → 릴레이 on-demand 구독으로 신규 메시지 실시간 수신.
인메모리 chat-store(`useSyncExternalStore`)로 리액티브 렌더링하고, 페이지 이탈 시 구독 해제 + 메모리 해제.

**분쟁 판정**: Admin이 remitted 상태에서 판정 버튼으로 실행한다.
- `sponsor_wins`: hold invoice settle → Sponsor에게 BTC 전송 (disburseSponsor 재사용)
- `customer_wins`: hold invoice cancel → Customer BTC 자동 환불 (이미 settle된 경우 경고)

**커밋먼트 검증**: Sponsor가 `account-reveal` 메시지로 계좌정보를 공개하면,
Admin이 원본 `account-info` 이벤트의 `commitment` 태그와 `sha256(JSON.stringify(revealedAccountInfo))`를 대조하여 자동 검증한다.

미구현 기능 목록은 [TODO.md](TODO.md) 참조.

#### Admin 모듈 구조

```
admin/
  index.html              - Vite 엔트리
  vite.config.ts          - React + nodePolyfills, dev 서버 포트 5175
  src/
    main.tsx              - React 엔트리
    App.tsx               - 메인 레이아웃, PriceTracker + NodeTracker + InvoiceWatcher 관리
    types.ts              - ProcessedRequest, DecodedBolt11, Invoice 타입 + 파서
    state-machine.ts      - 통합 FSM (canTransition, 상태 전이 맵)
    order-store.ts        - 오더 반응형 스토어 (localStorage, useSyncExternalStore)
    request-store.ts      - 요청 반응형 스토어 (localStorage, useSyncExternalStore)
    escrow-store.ts       - 프리이미지 저장소 (localStorage, settle 권한)
    chat-store.ts         - 분쟁 채팅 스토어 (인메모리, useSyncExternalStore)
    idb-store.ts          - IndexedDB 장기 저장소 (오더+요청+채팅 메시지 보존)
    invoice-watcher.ts    - hold invoice 결제 감시 (15초 폴링, verified→escrowed 자동 전이)
    cleanup.ts            - 만료 삭제 스케줄러 (60초 주기, order+request+escrow 연쇄 삭제)
    nostr/
      storage.ts          - StorageAdapter
      nip46.ts            - NIP-46 원격 서명 (BunkerSigner 세션 관리)
      ln-config.ts        - NIP-78 LN 설정 타입, 발행
      ln-config-service.ts - LN 설정 구독 서비스 (쓰기 릴레이)
      subscribe.ts        - kind 1111 + 30402 구독
      service.ts          - 구독 서비스 + 자동 처리 핸들러 + IndexedDB 동기화
      publish.ts          - kind 30402 오더 + dispute-message 발행 (NIP-46 서명)
      chat-subscribe.ts   - 분쟁 채팅 on-demand 구독 (디테일 페이지용)
    lightning/
      types.ts            - NodeInfo, DecodedInvoice, ProbeResult, HoldInvoiceResult, HoldInvoiceStatus
      adapter.ts          - LightningAdapter 인터페이스
      lnd.ts              - LND REST 어댑터 (getInfo, probe, createHoldInvoice, lookupHoldInvoice)
      cln.ts              - CLN clnrest 어댑터 (hold invoice 미지원)
      node-tracker.ts     - 노드 상태 폴링 트래커 (30초, useSyncExternalStore)
      index.ts            - 팩토리 (LnConfig → LightningAdapter) + re-exports
    components/
      LoginScreen.tsx     - NIP-46 로그인 화면
      LnConfigPage.tsx    - LN 노드 설정 입력/저장 폼
      OrderQueue.tsx      - 주문 단위 클레임 대기열
      OrderClaimList.tsx  - 주문별 클레임 목록
      ClaimCard.tsx       - 개별 클레임 카드 (승인/거절 + 유동성 검증)
      HistoryPage.tsx     - 히스토리 목록 (IDB 커서 기반 페이지네이션, 상태 필터)
      OrderDetail.tsx     - 오더 상세 + 분쟁 채팅창 2개 + 판정 버튼
      ChatWindow.tsx      - 채팅 UI (커밋먼트 검증 배지 포함)
      SatsAmount.tsx      - 사토시 금액 포맷팅
      BtcPrice.tsx        - BTC/KRW 실시간 가격
      NodeStatus.tsx      - Lightning 노드 연결 상태
```

#### Admin 저장소 이중화

Admin은 **localStorage**(실시간 큐)와 **IndexedDB**(장기 보존)를 이중으로 운영한다.

```
localStorage: 실시간 오더/요청 큐 (만료 시 공격적 삭제)
IndexedDB:    에스크로 책임이 있는 오더 (verified → escrowed 진입 이후)
```

**IndexedDB 스키마** (DB: `admin-history`, ver 2):

`orders` 스토어 — PK: `orderId`, 인덱스: `createdAt`, `[state, createdAt]`
`requests` 스토어 — PK: `eventId`, 인덱스: `orderId`
`messages` 스토어 — PK: `eventId`, 인덱스: `orderId`, `createdAt`, `[orderId, createdAt]`

레코드 형식은 localStorage와 동일 (Order, ProcessedRequest 타입 그대로 저장).
messages 스토어는 분쟁 채팅 메시지(ChatMessage 타입)를 영구 보존한다.

**이관 트리거**: `invoice-watcher.ts`에서 `verified → escrowed` 전이 시 해당 오더 + 연관 requests를 `idbMigrateOrder()`로 원자적 일괄 저장.

**동기화 전략**: 릴레이에서 오더/요청 수신 시 (`service.ts` onOrder/onRequest):
1. localStorage에 upsert
2. 해당 orderId로 IndexedDB 조회
3. 존재하면 → IndexedDB에도 upsert (관리 대상)
4. 미존재 → 무시 (아직 에스크로 전)

**삭제 전략**: localStorage는 `cleanup.ts`가 60초마다 만료 오더+요청+에스크로를 삭제. IndexedDB는 삭제하지 않는다 (장기 보존 목적).

## 기술 스택

| 영역 | Customer | Sponsor | Admin | Shared |
|------|----------|---------|-------|--------|
| 언어 | TypeScript | TypeScript | TypeScript | TypeScript |
| 프레임워크 | React 19 | React 19 | React 19 | - |
| 빌드 | Vite | Vite | Vite | (앱에서 컴파일) |
| 통신 | Nostr (nostr-tools) | Nostr (nostr-tools) | Nostr (nostr-tools) | Nostr (nostr-tools) |
| 저장소 | localStorage + IDB | localStorage + IDB | localStorage + IDB | StorageAdapter |
| 키 관리 | 랜덤 생성 | 랜덤 생성 | NIP-46 원격 서명 | ensureKeypair |
| 패키지 관리 | pnpm workspace | pnpm workspace | pnpm workspace | pnpm workspace |

## 유저 키 관리

- Customer/Sponsor 모두 최초 실행 시 `generateSecretKey()`로 랜덤 키페어 생성
- Secret key는 `number[]`로 변환하여 localStorage에 보관
- 키 관리 로직은 `@sajwo-tracker/shared`의 `ensureKeypair(storage)`로 통일
- Admin은 NIP-46 원격 서명을 사용하여 `.env` 의존성 없이 동작
- 유저스크립트 키 공유: 웹앱에서 nsec 표시 → 사용자가 Tampermonkey에 1회 입력 → GM_storage 보관

## 관련 문서

- [PROTOCOL.md](PROTOCOL.md) - Nostr 이벤트 프로토콜 명세 (3개 앱 공통)
- [TODO.md](TODO.md) - 향후 구현 계획
