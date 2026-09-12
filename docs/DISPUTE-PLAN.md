# 분쟁 중재 (Dispute Mediation) + 히스토리 UI 구현 플랜

> 상태: **아카이브 — 구현 완료** (분쟁 중재 + 히스토리 UI)
>
> 당시 계획 기록이다. 히스토리 UI는 **2026-09-12 통합**으로 '내 거래' 탭이 되었고,
> 역할은 칼럼 없이 pubkey 비교로 유도한다. 현행은 [ARCHITECTURE.md](../ARCHITECTURE.md) 참조.

## Context

`remitted` 상태의 오더에 대한 Admin 중재 기능이 필요하다. Sponsor가 KRW 송금을 주장(`escrowed → remitted`)한 후 Customer가 입금 확인을 하지 않는 상황에서, Admin이 양쪽과 각각 채팅으로 대화하고 증거를 검토한 뒤 `sponsor_wins` 또는 `customer_wins`를 판정하는 기능이다. 이와 함께 모든 앱에 히스토리 UI(IDB 기반 오더 목록 + 상세 페이지)를 추가한다.

FSM에는 이미 `sponsor_wins`/`customer_wins` 터미널 상태와 전이 규칙이 정의되어 있으나, 핸들러/UI/채팅 인프라는 전무하다.

---

## 핵심 설계 결정

### 1. 채팅 전송: kind 1111 `dispute-message` (NIP-17 사용하지 않음)

**NIP-17을 권장하지 않는 이유:**
- NIP-17 `wrapEvent()`는 raw private key 필수 → Admin의 NIP-46 BunkerSigner와 호환 불가 (커스텀 async gift-wrap 래퍼 필요)
- NIP-17 gift wrap은 outer 태그에 오더 참조(`a` 태그)를 넣을 수 없음 → 릴레이 측 orderId 필터링 불가
- 메타데이터 프라이버시 이점이 미미함 (릴레이가 이미 kind 30402/1111로 참여자 정보를 알고 있음)

**kind 1111 + NIP-44 암호화 사용 이유:**
- Admin의 BunkerSigner `nip44Encrypt`/`nip44Decrypt`가 완벽히 작동 (`ln-config.ts`에서 검증된 패턴)
- `a` 태그로 orderId 참조 → 기존 구독 인프라와 호환
- 기존 모든 request 이벤트 패턴과 일관성 유지

### 2. 채팅 저장: IndexedDB + 릴레이 하이브리드

| 방식 | 장점 | 단점 |
|------|------|------|
| 릴레이 전용 | 구현 단순, IDB 스키마 불필요 | rate limit/삭제 리스크, 증거 유실 가능, 로드 지연 |
| IDB + 릴레이 | 즉시 로딩, 증거 영구보존, 오프라인 접근 | IDB 마이그레이션 필요 |

**하이브리드 근거:**
- 릴레이 신뢰성 문제: rate limit, NIP-40 만료 삭제, 다운타임으로 분쟁 증거 유실 위험
- 기존 아키텍처가 이미 동일 패턴 사용: `relay → service → IDB + localStorage → UI` (Admin/Sponsor의 오더/리퀘스트 이중화)
- IDB → 즉시 로딩, 릴레이 → 라이브 전송
- **흐름**: 메시지 발행 → 릴레이 전송 → 수신 시 IDB 저장 → UI 업데이트. 재방문 시: IDB 즉시 로드 → 릴레이 구독으로 신규 메시지 수신

### 3. 메시지 만료: 없음 (expiration 태그 미포함)

기존 코딩 규칙 `"이벤트에는 반드시 expiration 태그 포함"`의 첫 번째 예외:
- **데이터 비대화 없음**: on-demand 구독이므로 항상-구독 이벤트(오더/리퀘스트)와 달리 로컬 데이터 누적 문제 없음
- **인메모리 스토어**: chat-store는 localStorage가 아닌 인메모리 → 디테일 페이지 이탈 시 즉시 해제. IDB는 용량 제한 관대
- **증거 보존 목적**: 분쟁 채팅은 판정 이후에도 참조될 수 있는 법적 증거 기록. 오더 만료와 무관하게 보존 필요
- **릴레이 삭제 무관**: IDB가 영구보존 담당. 릴레이가 자체 정책으로 삭제해도 무방

### 4. 채팅 구독: 디테일 페이지 진입 시에만 on-demand

- 메인 구독은 `dispute-message` 처리하지 않음 (skip)
- 디테일 페이지 진입 → IDB 로드(즉시) → 릴레이 구독 생성(라이브)
- 디테일 페이지 이탈 → 구독 해제

---

## 이벤트 구조

```
kind: 1111
tags:
  ['a', '30402:<admin-pubkey>:<orderId>']
  ['action', 'dispute-message']
  ['t', CLIENT_TAG]
  ['p', <recipient-pubkey>]
content: NIP-44 encrypted JSON →
  { "type": "text", "content": "메시지 내용" }
  또는
  { "type": "account-reveal", "accountInfo": { bankName, accountNumber, holderName } }
```

---

## 타입 정의

```typescript
// shared/src/types.ts
interface DisputeMessagePayload {
  type: 'text' | 'account-reveal';
  content?: string;             // type: 'text'
  accountInfo?: AccountInfo;    // type: 'account-reveal'
}

interface ChatMessage {
  eventId: string;
  orderId: string;
  senderPubkey: string;
  recipientPubkey: string;
  payload: DisputeMessagePayload;
  createdAt: number;
}
```

---

## 구현 단계

### Phase 0: Shared 기반 (shared/)

| 파일 | 변경 |
|------|------|
| `shared/src/constants.ts` | `REQUEST_ACTIONS`에 `DISPUTE_MESSAGE: 'dispute-message'` 추가 |
| `shared/src/types.ts` | `DisputeMessagePayload`, `ChatMessage` 타입 추가 |
| `shared/src/index.ts` | 새 타입 export |

### Phase 1: IDB 스키마 마이그레이션

**Admin** (`admin/src/idb-store.ts`):
- `DB_VERSION` 1 → 2
- `onupgradeneeded`에 `if (oldVersion < 2)` 가드로 `messages` 오브젝트 스토어 추가
  - PK: `eventId`, 인덱스: `orderId`, `createdAt`, `['orderId', 'createdAt']`
- 기존 `if (!db.objectStoreNames.contains(...))` 패턴 → `if (oldVersion < N)` 패턴으로 리팩토링
- `idbUpsertMessage()`, `idbGetMessagesByOrderId()` API 추가
- 히스토리 페이지네이션용 `idbGetOrdersPage(cursor?, limit)` 추가 (커서 기반, `[state, createdAt]` 복합 인덱스 활용)

**Sponsor** (`sponsor/src/idb-store.ts`):
- 동일한 version 2 마이그레이션 + message API

**Customer** (`customer/src/idb-store.ts` — 신규):
- `customer-history` DB, version 1
- `messages` 스토어만 (오더/리퀘스트는 기존 localStorage 유지)
- 최소한의 IDB — 분쟁 채팅 증거 보존 목적

### Phase 2: 채팅 발행 함수 (Nostr)

**Admin** (`admin/src/nostr/publish.ts`):
```typescript
publishDisputeMessage(orderId, recipientPubkey, payload, expiration)
// BunkerSigner.nip44Encrypt(recipientPubkey, plaintext) → kind 1111 발행
// Admin은 Customer/Sponsor 양쪽 모두에게 발행 가능
```

**Customer** (`customer/src/nostr/publish.ts`):
```typescript
publishDisputeMessage(order, payload)
// nip44Encrypt(plaintext, sk, APP_PUBKEY) → kind 1111 발행
// 수신자는 항상 APP_PUBKEY (Admin)
```

**Sponsor** (`sponsor/src/nostr/claim.ts`에 추가):
```typescript
publishDisputeMessage(order, payload)
publishAccountReveal(order)  // type: 'account-reveal' 특수 메시지
// 수신자는 항상 APP_PUBKEY (Admin)
```

### Phase 3: 채팅 구독 모듈 (on-demand)

각 앱에 `nostr/chat-subscribe.ts` 신규 생성:
- 디테일 페이지 마운트 시 호출, 언마운트 시 cleanup
- 필터: `kinds: [1111], #a: ['30402:<admin>:<orderId>'], #t: [CLIENT_TAG]`
- 클라이언트 사이드 `action === 'dispute-message'` 필터링 (릴레이가 multi-char 태그 인덱싱 미보장)
- NIP-44 복호화 → `ChatMessage` 변환 → 콜백

**Admin NIP-44 복호화 주의사항:**
- 수신 메시지: `signer.nip44Decrypt(event.pubkey, ciphertext)` (상대방 pubkey)
- 자기 발신 에코: `signer.nip44Decrypt(recipientPubkey, ciphertext)` (원래 수신자 pubkey)
- `event.pubkey === APP_PUBKEY` 조건으로 분기

### Phase 4: 리액티브 채팅 스토어

각 앱에 `chat-store.ts` 신규 생성:
- `useSyncExternalStore` 호환 (기존 order-store 패턴 동일)
- 인메모리 `Record<orderId, ChatMessage[]>` + `subscribe()`/`getSnapshot()`
- `addMessage(msg)`: eventId 기반 중복 제거 + createdAt 정렬
- `loadFromIdb(orderId)`: 디테일 페이지 진입 시 IDB에서 기존 메시지 로드

### Phase 5: 분쟁 판정 핸들러 (Admin)

`admin/src/nostr/service.ts`에 추가:

**`resolveDisputeSponsorWins(orderId)`:**
1. FSM 검증: `canTransition('remitted', 'sponsor_wins')`
2. Hold invoice settle (이미 safety net이 settle한 경우 skip)
3. `publishOrder({...order, state: 'sponsor_wins'})`
4. `disburseSponsor(orderId)` 호출 (기존 함수 재사용)

**`resolveDisputeCustomerWins(orderId)`:**
1. FSM 검증: `canTransition('remitted', 'customer_wins')`
2. Hold invoice cancel (아직 `accepted` 상태인 경우) → Customer BTC 자동 환불
3. 이미 safety net settle된 경우 → 별도 LN 결제로 환불 필요 (TODO.md line 44와 연계)
4. `publishOrder({...order, state: 'customer_wins'})`

**커밋먼트 대조 검증:**
- Sponsor가 `account-reveal` 메시지 발신 시 Admin 자동 검증
- `idbGetRequestsByOrderId(orderId)` → `action === 'account-info'` 이벤트 찾기
- `sha256(JSON.stringify(revealedAccountInfo))` === `commitment` 태그 비교
- UI에 검증 결과 배지 표시 (녹색 체크 or 경고)

**메인 구독에서 dispute-message 처리:**
- `service.ts`의 action dispatcher에 `dispute-message` 분기 추가
- IDB에 orderId가 존재하면 fire-and-forget으로 `idbUpsertMessage()` 호출
- 리액티브 스토어 갱신은 하지 않음 (디테일 페이지의 on-demand 구독이 담당)

### Phase 6: 히스토리 UI

**Admin** (`admin/src/App.tsx` + 컴포넌트):
- 라우팅 확장: `?page=history` (히스토리 목록), `?page=detail&order=<id>` (상세)
- 기존 `?order=<id>` 호환 유지
- `HistoryPage.tsx` (신규): IDB 오더 커서 기반 페이지네이션 (최신순), 상태 필터 지원
- 헤더에 "히스토리" 네비게이션 버튼 추가

**Sponsor** (`sponsor/src/App.tsx` + 컴포넌트):
- 라우팅 추가: `?page=history`, `?page=detail&order=<id>`
- `HistoryPage.tsx` (신규): IDB 오더 목록

**Customer** (`customer/src/components/`):
- 별도 히스토리 페이지 불필요 (기존 OrderTable에서 직접 접근)
- OrderRow 클릭 시 `OrderDetail.tsx` (신규) 모달/확장 표시

### Phase 7: 오더 상세 + 채팅 UI

**Admin `OrderDetail.tsx`** (신규):
- 오더 요약 (상태, 가격, 만료, pubkey 등)
- 리퀘스트 히스토리 (IDB 조회)
- 채팅창 2개 (Customer <-> Admin, Sponsor <-> Admin)
- 분쟁 판정 버튼 (state === 'remitted'일 때): "후원자 승리" / "고객 승리" (확인 다이얼로그)

**`ChatWindow.tsx`** (각 앱 공통 패턴):
- 메시지 리스트 (스크롤, 시간순 정렬)
- 하단 입력 필드 + 전송 버튼
- 신규 메시지 시 자동 스크롤
- `useSyncExternalStore(subscribeChatStore, getChatSnapshot)` 으로 리액티브 렌더링

**Sponsor 전용:**
- "계좌정보 제출" 버튼: IDB에서 해당 오더의 계좌정보 로드 → `account-reveal` 메시지 발신

**Admin 전용:**
- `account-reveal` 메시지에 커밋먼트 검증 배지 자동 표시

---

## 의존 관계 및 병렬화

```
Phase 0 (shared 타입) ─────────┬─── Phase 1 (IDB 마이그레이션)
                               ├─── Phase 2 (발행 함수)
                               └─── Phase 8 (메인 구독 skip 처리)

Phase 1 ───┬─── Phase 3 (채팅 구독)
            └─── Phase 6 (히스토리 UI)

Phase 3 ───── Phase 4 (리액티브 스토어)

Phase 2 + Phase 5 (분쟁 핸들러) ──→ 어드민 전용, 병렬 가능

Phase 4 + Phase 5 + Phase 6 ───── Phase 7 (상세 + 채팅 UI)
```

Phase 0/1/2/8은 병렬 진행 가능. Phase 6(히스토리)은 채팅과 독립적.

---

## 수정/생성 파일 목록

### 수정
| 파일 | 내용 |
|------|------|
| `shared/src/constants.ts` | DISPUTE_MESSAGE 상수 |
| `shared/src/types.ts` | DisputeMessagePayload, ChatMessage |
| `shared/src/index.ts` | 새 타입 export |
| `admin/src/idb-store.ts` | v2 마이그레이션 + message API + pagination API |
| `admin/src/nostr/publish.ts` | publishDisputeMessage |
| `admin/src/nostr/service.ts` | resolveDisputeSponsorWins/CustomerWins + dispute-message skip |
| `admin/src/App.tsx` | 라우팅 확장 (history/detail) |
| `sponsor/src/idb-store.ts` | v2 마이그레이션 + message API + pagination API |
| `sponsor/src/nostr/claim.ts` | publishDisputeMessage, publishAccountReveal |
| `sponsor/src/App.tsx` | 라우팅 추가 |
| `customer/src/nostr/publish.ts` | publishDisputeMessage |

### 신규
| 파일 | 내용 |
|------|------|
| `customer/src/idb-store.ts` | Customer IDB (messages 스토어만) |
| `admin/src/nostr/chat-subscribe.ts` | On-demand 채팅 구독 |
| `admin/src/chat-store.ts` | 리액티브 채팅 스토어 |
| `admin/src/components/HistoryPage.tsx` | 히스토리 목록 페이지 |
| `admin/src/components/OrderDetail.tsx` | 오더 상세 + 채팅창 |
| `admin/src/components/ChatWindow.tsx` | 채팅 UI 컴포넌트 |
| `sponsor/src/nostr/chat-subscribe.ts` | On-demand 채팅 구독 |
| `sponsor/src/chat-store.ts` | 리액티브 채팅 스토어 |
| `sponsor/src/components/HistoryPage.tsx` | 히스토리 목록 |
| `sponsor/src/components/OrderDetail.tsx` | 오더 상세 + 채팅창 |
| `sponsor/src/components/ChatWindow.tsx` | 채팅 UI |
| `customer/src/nostr/chat-subscribe.ts` | On-demand 채팅 구독 |
| `customer/src/chat-store.ts` | 리액티브 채팅 스토어 |
| `customer/src/components/OrderDetail.tsx` | 오더 상세 + 채팅창 |
| `customer/src/components/ChatWindow.tsx` | 채팅 UI |

---

## 우려사항 및 대응

1. **Admin BunkerSigner NIP-44**: `ln-config.ts`에서 `signer.nip44Encrypt()/nip44Decrypt()` 패턴 검증 완료. 자기 발신 에코 복호화 시 recipient pubkey 사용 필요 (NIP-44 conversation key는 대칭)

2. **IDB 마이그레이션 안전성**: `if (oldVersion < N)` 가드 패턴으로 기존 데이터 보존. 브라우저 네이티브 IDB 업그레이드가 자동 처리

3. **릴레이 필터 효율성**: `#a` 태그 필터는 대부분의 모던 릴레이 지원. `#action` 필터는 미보장 → 클라이언트 사이드 필터링 필수

4. **Customer IDB 도입**: 분쟁은 드문 케이스이나 증거 보존이 중요하므로, 최소한의 `messages` 스토어만 추가 (오더/리퀘스트는 기존 localStorage 유지)

5. **customer_wins + 이미 settle된 hold invoice**: 별도 LN 결제 환불 메커니즘 필요 (TODO.md line 44 참고, 이번 스코프에서는 상태 전이까지만 구현하고 LN 환불은 경고 메시지로 처리)

---

## 검증 방법

1. `pnpm build:customer && pnpm build:sponsor && pnpm build:admin` 빌드 통과
2. Admin 앱에서 히스토리 페이지 진입 → IDB 오더 목록 정상 표시
3. Admin 오더 상세 → 채팅창 2개 표시 → 메시지 발신 → 릴레이 발행 확인
4. Customer/Sponsor 앱에서 채팅 메시지 수신 → 복호화 → UI 표시
5. Sponsor "계좌정보 제출" → Admin 커밋먼트 자동 검증 → 배지 표시
6. Admin "후원자 승리" / "고객 승리" 판정 → kind 30402 발행 → 상태 전이 확인
7. 페이지 재방문 시 IDB에서 기존 메시지 즉시 로드 확인
