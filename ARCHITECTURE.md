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
        ↑                    ↑                    ↑
        │                    │                    │
   ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
   │ Customer │          │ Sponsor │          │  Admin  │
   │   App    │          │   App   │          │   App   │
   └─────────┘          └─────────┘          └─────────┘
   Chrome Extension      React SPA            React SPA
   (BTC로 물건 구매)     (KRW→BTC 환전)     (에스크로 + LN 노드 제어)
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
  customer/                 ← Customer용 Chrome Extension
  sponsor/                  ← Sponsor용 React SPA
  admin/                    ← Admin 에스크로 서비스 (순수 프론트엔드)
```

| 폴더 | 설명 | 형태 | 대상 사용자 |
|------|------|------|------------|
| `shared/` | Nostr 공통 모듈 (키, 릴레이, 상수, 타입) | TypeScript 라이브러리 | - |
| `customer/` | 쿠팡 무통장입금 주문 감지 + 사줘 요청 발행 | Chrome Extension (MV3) | 비트코인으로 물건을 사고 싶은 사람 |
| `sponsor/` | 오더북에서 사줘 요청 확인 + 클레임 발행 | React SPA | 거래소 없이 BTC를 사고 싶은 사람 |
| `admin/` | 에스크로 (유동성 검증, 중재) | React SPA (순수 프론트엔드) | 시스템 운영자 |

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
    └─> KRW 입금 확인 시 Admin이 hold invoice settle → BTC 수령
    └─> Admin이 Sponsor에게 BTC 전송 (Lightning)
    └─> 문제 발생 시: settle 안 함 → CLTV timeout 후 Customer에게 자동 환불

11. 완료 (Customer)
    └─> 쿠팡에서 입금 확인, Nostr에 sold 이벤트 재발행
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

비트코인으로 물건을 사고 싶은 사람이 사용하는 Chrome Extension (Manifest V3).
쿠팡 주문 페이지에서 동작한다.

- 쿠팡 주문 페이지 파싱 및 무통장입금 주문 감지 (+ 입금 완료/취소 자동 감지)
- kind 1111로 Admin에 요청 전송 (order-request, payment-confirm, cancel-request)
- Admin의 kind 30402 오더 구독으로 상태 자동 반영 (로컬 FSM 없음)
- 팝업/대시보드에서 사줘 요청 버튼으로 수동 발행

#### Customer 모듈 구조

```
customer/src/
  background/index.ts   - Nostr 초기화, 릴레이 구독, SEND_REQUEST 메시지 핸들러
  content/index.ts      - 쿠팡 페이지 파싱, 주문 감지, 입금완료/취소 자동 감지
  nostr/
    storage.ts          - chrome.storage.local 기반 StorageAdapter
    events.ts           - kind 1111 요청 이벤트 빌드 (order-request, payment-confirm, cancel-request)
    publish.ts          - SimplePool 기반 요청 브로드캐스트
    admin-orders.ts     - Admin kind 30402 오더 구독, adminState 자동 반영
  shared/
    types.ts            - TrackedOrder, 쿠팡 API 타입
    storage.ts          - chrome.storage.local 주문 CRUD
    order-states.ts     - adminState + raw 기반 표시 상태 결정
    filter.ts           - 쿠팡 데이터 파싱
  dev-only/             - Dev 환경 전용 (테스트 주문 생성)
  popup/                - 팝업 UI
  dashboard/            - 전체화면 대시보드 UI
```

### Sponsor App

거래소를 거치지 않고 비트코인을 사고 싶은 사람이 사용하는 React 19 + TypeScript SPA.
무통장입금을 대행해주고 그 대가로 BTC를 수령한다.

- Nostr에서 사줘 요청 실시간 구독 (SimplePool.subscribeMany)
- 오더북 형태로 활성 요청 목록 표시 (만료 임박순 정렬, 만료된 것 자동 필터링)
- localStorage에 주문 영구 캐시 (즉시 로드 후 백그라운드 동기화)
- sold 상태 이벤트 수신 시 주문 자동 삭제
- 남은 시간 매초 자동 갱신
- pubkey 기반 이벤트 검증 (같은 orderId라도 최초 발행자만 갱신/삭제 가능)

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
  probe(destination: string, amountSat: number, finalCltvDelta?: number, routeHints?: RouteHintHop[][]): Promise<ProbeResult>;
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

**향후 구현:**
- **에스크로 관리**: Hold invoice로 Customer BTC 에스크로
- **Customer fidelity bond**: 사줘 요청 시 주문 금액 일부를 hold invoice로 선납 (스팸 차단)
- **Sponsor 블랙리스트**: Lightning 노드 pubkey 기반 트롤링 차단
- **릴레이 목록 관리**: kind 10002 이벤트 발행/수정
- **모니터링 대시보드**: 시스템 전체 현황 파악

#### Admin 모듈 구조

```
admin/
  index.html              - Vite 엔트리
  vite.config.ts          - React + nodePolyfills, dev 서버 포트 5175
  src/
    main.tsx              - React 엔트리
    App.tsx               - 메인 레이아웃, PriceTracker + NodeTracker 관리
    types.ts              - ClaimEvent, DecodedBolt11, OrderRef 타입 + 파서
    claim-store.ts        - 클레임 반응형 스토어 (localStorage)
    order-store.ts        - 주문 참조 스토어 (localStorage)
    nostr/
      storage.ts          - StorageAdapter
      nip46.ts            - NIP-46 원격 서명 (BunkerSigner 세션 관리)
      ln-config.ts        - NIP-78 LN 설정 타입, 발행, 구독, 복호화
      ln-config-service.ts - LN 설정 구독 서비스 (쓰기 릴레이)
      subscribe.ts        - kind 1111 + 30402 구독
      service.ts          - 구독 시작/중지
    lightning/
      types.ts            - NodeInfo, DecodedInvoice, ProbeResult, LnConnectionConfig
      adapter.ts          - LightningAdapter 인터페이스 (getInfo, decodeInvoice, probe)
      lnd.ts              - LND REST 어댑터 (브라우저에서 직접 호출)
      cln.ts              - CLN clnrest 어댑터 (브라우저에서 직접 호출)
      node-tracker.ts     - 폴링 트래커 (useSyncExternalStore 호환)
      index.ts            - 팩토리 (LnConfig → LightningAdapter) + re-exports
    components/
      LoginScreen.tsx     - NIP-46 로그인 화면
      LnConfigPage.tsx    - LN 노드 설정 입력/저장 폼
      OrderQueue.tsx      - 주문 단위 클레임 대기열
      OrderClaimList.tsx  - 주문별 클레임 목록
      ClaimCard.tsx       - 개별 클레임 카드 (승인/거절 + 유동성 검증)
      SatsAmount.tsx      - 사토시 금액 포맷팅
      BtcPrice.tsx        - BTC/KRW 실시간 가격
      NodeStatus.tsx      - Lightning 노드 연결 상태
```

## 기술 스택

| 영역 | Customer | Sponsor | Admin | Shared |
|------|----------|---------|-------|--------|
| 언어 | TypeScript | TypeScript | TypeScript | TypeScript |
| 프레임워크 | Chrome Extension (MV3) | React 19 | React 19 | - |
| 빌드 | Vite + CRXJS | Vite | Vite | (앱에서 컴파일) |
| 통신 | Nostr (nostr-tools) | Nostr (nostr-tools) | Nostr (nostr-tools) | Nostr (nostr-tools) |
| 저장소 | chrome.storage.local | localStorage | localStorage | StorageAdapter |
| 키 관리 | 랜덤 생성 | 랜덤 생성 | NIP-46 원격 서명 | ensureKeypair |
| 패키지 관리 | pnpm workspace | pnpm workspace | pnpm workspace | pnpm workspace |

## 관련 문서

- [PROTOCOL.md](PROTOCOL.md) - Nostr 이벤트 프로토콜 명세 (3개 앱 공통)
- [TODO.md](TODO.md) - 향후 구현 계획
- [STORAGE-STRATEGY.md](STORAGE-STRATEGY.md) - 영구저장소 이중화 전략 (localStorage + IndexedDB)
