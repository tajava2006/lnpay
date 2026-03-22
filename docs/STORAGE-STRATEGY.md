# Admin 중심 아키텍처 전환 + 저장소 이중화

> 상태: **Phase 2 완료** | 작성일: 2026-02-18

두 가지 변경을 동시에 진행한다:
1. **아키텍처 전환**: 상태 소유권을 Admin으로 일원화
2. **저장소 이중화**: localStorage(실시간 UI) + IndexedDB(거래 히스토리)

---

## 1. 현재 아키텍처의 문제

### 신뢰 모델 ≠ 데이터 모델

에스크로 서비스에서 Admin은 유일한 신뢰 기관이다. 유동성 검증, hold invoice, settlement, 분쟁 중재 — 모든 핵심 비즈니스 로직이 Admin을 거친다.

그런데 현재 데이터 모델은 3개 앱이 **각자 상태를 독립적으로 관리**한다:

- Customer가 kind 30402를 직접 발행하고, 자체 FSM으로 상태 전이를 관리한다
- Sponsor가 로컬에서 `detected → claimed → approved → selected → completed` FSM을 돌린다
- Admin은 클레임 상태(`pending → approved → rejected`)를 별도로 관리한다

같은 오더에 대해 3개의 독립된 FSM이 존재하고, 이들의 상태를 동기화하려면 앱 간 알림 프로토콜이 필요한데 이것이 미구현 상태다. 구현하더라도 3자 간 상태 동기화는 본질적으로 복잡하다.

### 저장소 한계

이 문제는 [이전 분석](#appendix-localstorage-한계-분석)에서 다룬다. 요약하면:
- localStorage의 용량 제한 + 전량 직렬화 구조가 장기 운영에 부적합
- 삭제할 수 없는 데이터(거래 기록)와 삭제해야 하는 데이터(만료 오더)가 같은 저장소에 있어 삭제 전략이 복잡해짐

---

## 2. 새 아키텍처: Admin 중심 상태 관리

### 핵심 원칙

**Admin이 모든 오더의 유일한 상태 소유자**이다.

- Admin만이 kind 30402 (오더 이벤트)를 발행하고 상태를 변경한다
- Customer와 Sponsor는 kind 1111로 **요청(신청)**만 한다
- 상태 전이 로직(FSM)은 오직 Admin에만 존재한다
- Customer/Sponsor는 Admin이 발행한 오더 상태를 그대로 표시한다

```
현재:
  Customer ──[kind 30402 발행]──→ Relay ←──[로컬 FSM]── Sponsor
                                   ↑
                              Admin [별도 FSM]

변경 후:
  Customer ──[kind 1111 요청]──→ Relay ──→ Admin ──[kind 30402 발행/갱신]──→ Relay
                                                                             ↓
  Sponsor ──[kind 1111 요청]──→ Relay ──→ Admin              Customer/Sponsor [표시만]
```

### 이 변경이 정당한 이유

- **신뢰 모델과 데이터 모델의 일치**: Admin이 에스크로 권한을 가졌으면 상태 소유권도 Admin이 가지는 것이 정직하다
- **FSM 단일화**: 3개의 독립 FSM이 1개로 줄어든다. 상태 동기화 문제가 구조적으로 소멸한다
- **앱 간 알림 프로토콜 불필요**: Admin이 kind 30402를 갱신하면 구독 중인 모든 앱이 자동으로 최신 상태를 받는다
- **pubkey 검증 단순화**: 모든 kind 30402의 author가 Admin이므로 `event.pubkey === ADMIN_PUBKEY`만 확인하면 된다
- **Admin 단일 장애점 우려는 현실적이지 않다**: Admin 없이는 유동성 검증, hold invoice, settlement이 불가능하므로 이미 사실상 단일 장애점이다. 차이가 있다면 현재는 오더 발행/클레임까지는 Admin 없이 가능하다는 것인데, 어차피 이후 단계가 전부 Admin 의존이므로 차라리 처음부터 Admin을 거치는 것이 명확하다
- **탈중앙화에서 멀어지는 것은 문제가 아니다**: Nostr는 메시징 채널로 사용할 뿐, 에스크로 비즈니스 로직은 본질적으로 중앙화된 신뢰 모델이다

---

## 3. Nostr 이벤트 모델 변경

### kind 30402: Admin이 발행하는 오더 이벤트

```
주소: 30402:<admin-pubkey>:<orderId>
발행자: Admin (유일)
```

현재는 Customer가 발행하고 `30402:<customer-pubkey>:<orderId>`로 주소가 잡힌다.
변경 후 Admin이 유일한 발행자가 되므로 `30402:<admin-pubkey>:<orderId>`가 된다.

**주요 태그 변경:**

| 태그 | 설명 |
|------|------|
| `d` | orderId (기존과 동일) |
| `t` | `sajwo-tracker` (기존과 동일) |
| `status` | `active` \| `sold` (기존과 동일) |
| `price` | 금액, 통화 (기존과 동일) |
| `expiration` | 만료 시각 (기존과 동일) |
| `customer` | **신규** — 주문 요청자(Customer)의 pubkey |
| `state` | **신규** — 세부 상태 (아래 FSM 참조) |

**상태 머신 (Admin 단일 FSM):**

```
requested → claimed → verified → escrowed ─→ remitted ─→ paid
                                    │                ├──→ sponsor_wins
                                    └──→ paid        └──→ customer_wins

cancelled: remitted를 제외한 비터미널 상태에서 전이 가능
터미널: paid, cancelled, sponsor_wins, customer_wins
```

- `requested`: Customer가 사줘 요청을 보냄, Admin이 오더 생성
- `claimed`: Sponsor가 클레임, Admin이 수락
- `verified`: Admin이 유동성 검증 완료
- `escrowed`: Customer가 hold invoice 결제, BTC 에스크로 중
- `remitted`: Sponsor가 KRW 송금했다고 주장
- `paid`: 거래 완료 (최종)
- `cancelled`: 취소 (최종)
- `sponsor_wins`: 분쟁 — 후원자 승리, hold invoice settle (최종)
- `customer_wins`: 분쟁 — 고객 승리, hold invoice 환불 (최종)

`state` 태그는 다중 문자이므로 릴레이 인덱싱이 보장되지 않는다. 필터링은 클라이언트 사이드에서 수행한다. `status` 태그(`active`/`sold`)는 NIP-99 호환을 위해 유지한다.

### kind 1111: Customer/Sponsor의 요청 이벤트

Customer와 Sponsor의 모든 상호작용은 kind 1111 이벤트로 Admin에게 **요청**하는 형태다.
Admin이 요청을 검토하고, 타당하면 kind 30402를 갱신한다.

**공통 태그:**

| 태그 | 설명 |
|------|------|
| `t` | `sajwo-tracker` |
| `p` | Admin pubkey (Admin이 `#p` 필터로 수신) |
| `action` | **신규** — 요청 종류를 식별하는 커스텀 태그 |
| `expiration` | 관련 오더와 동일한 만료 시각 |

**요청 종류 (action 태그 값):**

| action | 발행자 | 설명 | 비고 |
|--------|--------|------|------|
| `order-request` | Customer | 사줘 요청 신청 | a-tag으로 오더 참조 (아직 이벤트가 존재하지 않지만 주소는 알 수 있음) |
| `claim` | Sponsor | 클레임 신청 | a-tag으로 오더 참조, bolt11 태그 포함 |
| `payment-confirm` | Customer | 입금 완료 신고 | a-tag으로 오더 참조 |
| ... | ... | 향후 추가 가능 | |

### 모든 요청에 a-tag 포함

모든 kind 1111 요청은 대상 오더의 a-tag(`30402:<admin-pubkey>:<orderId>`)를 포함한다.
최초 `order-request` 시점에는 아직 해당 kind 30402 이벤트가 릴레이에 존재하지 않지만,
addressable event의 주소(`30402:<admin-pubkey>:<orderId>`)는 구성 요소가 모두 알려져 있으므로 a-tag을 넣을 수 있다.
Nostr 릴레이는 a-tag 대상 이벤트의 존재 여부를 검증하지 않는다.

단, e-tag(특정 이벤트 ID 참조)는 최초 요청 시점에 이벤트가 없으므로 포함할 수 없다.
이후의 요청(`claim`, `payment-confirm` 등)에서는 이미 생성된 kind 30402의 이벤트 ID를 e-tag으로 참조할 수 있다.

### 만료 태그 통일

**오더와 관련된 모든 kind 1111 이벤트에 오더와 동일한 만료 시각을 부여한다.**

현재는 kind 30402에만 `expiration` 태그가 있고, kind 1111에는 없다.
이를 통일하여:

- 오더가 만료되면 관련된 모든 요청 이벤트도 릴레이에서 함께 정리된다
- 만료된 과거 요청이 릴레이에 남아 불필요하게 수신되는 것을 방지한다
- Admin이 오프라인이었다가 복귀했을 때, 이미 만료된 요청을 받아 처리하려는 상황을 차단한다

---

## 4. 앱별 역할 변경

### Customer

| 항목 | 현재 | 변경 후 |
|------|------|---------|
| 오더 발행 | kind 30402 직접 발행 | kind 1111 `order-request` 발행 |
| 상태 관리 | 자체 FSM (6개 상태) | 없음 — Admin의 상태를 그대로 표시 |
| 저장소 | chrome.storage.local (오더 전량) | chrome.storage.local (자기 오더만, 기존과 동일) |
| 구독 | 없음 (자기 데이터만) | Admin의 kind 30402 구독 (자기 오더 상태 추적) |

Customer는 쿠팡 주문 파싱 → kind 1111 발행까지만 하고, 이후 상태는 Admin의 이벤트를 구독하여 표시한다.
내부적으로 `detected`(파싱했지만 아직 발행 안 함) 같은 순수 로컬 상태는 유지할 수 있다.

### Sponsor

| 항목 | 현재 | 변경 후 |
|------|------|---------|
| 오더북 표시 | kind 30402 구독 (Customer가 발행) | kind 30402 구독 (Admin이 발행) |
| 클레임 | kind 1111 발행 + 로컬 FSM 상태 변경 | kind 1111 `claim` 발행만 |
| 상태 관리 | 자체 FSM (6개 상태) | 없음 — Admin의 상태를 그대로 표시 |
| 저장소 | localStorage (오더 + 로컬 상태) | localStorage (오더북 표시 전용, 읽기 전용) |

Sponsor의 로컬 FSM이 완전히 사라진다. `state-machine.ts` 파일 자체가 불필요해진다.
오더의 상태는 Admin이 발행한 kind 30402의 `state` 태그를 그대로 읽으면 된다.

### Admin

| 항목 | 현재 | 변경 후 |
|------|------|---------|
| 이벤트 발행 | 없음 (로컬 상태만 관리) | kind 30402 발행 + 갱신 (유일한 상태 소유자) |
| 상태 관리 | 클레임 상태만 (`pending/approved/rejected`) | **전체 오더 FSM** (유일한 FSM) |
| 구독 | kind 30402 + kind 1111 (읽기 전용) | kind 1111 (요청 수신) + 자기 kind 30402 (동기화) |
| 저장소 | localStorage 2개 (orders + claims) | localStorage (실시간 UI) + **IndexedDB (거래 히스토리)** |

Admin이 시스템의 **두뇌**가 된다. 모든 요청을 수신하고, 검증하고, 상태를 변경하고, 이벤트를 발행한다.

---

## 5. 구독 필터 변경

### Customer — 자기 오더 상태 추적

```json
{ "kinds": [30402], "authors": ["<admin-pubkey>"], "#t": ["sajwo-tracker"], "#customer": ["<my-pubkey>"] }
```

> `#customer`는 다중 문자 태그이므로 릴레이 인덱싱이 보장되지 않는다. 인덱싱되지 않는 릴레이에서는 `authors` + `#t`까지만 서버에서 필터링되고, `#customer`는 클라이언트 사이드에서 필터링한다.

### Sponsor — 오더북

```json
{ "kinds": [30402], "authors": ["<admin-pubkey>"], "#t": ["sajwo-tracker"] }
```

author가 Admin으로 한정되므로 구독 필터가 더 정확해진다.
현재는 모든 pubkey의 kind 30402를 받아 `#t` 필터링하지만, 변경 후 Admin의 이벤트만 받는다.

### Admin — 요청 수신

```json
{ "kinds": [1111], "#p": ["<admin-pubkey>"], "#t": ["sajwo-tracker"] }
```

모든 Customer/Sponsor의 요청을 `#p` 필터로 수신한다.
`action` 태그로 요청 종류를 분류한다.

---

## 6. 저장소 이중화 전략

아키텍처 전환과 함께 저장소 전략이 **크게 단순해진다**.

### 전체 구조

```
Admin:
  kind 1111 요청 수신 → 서비스 레이어 → localStorage (실시간 큐)
  상태 변경 결정      → FSM          → kind 30402 발행 + IndexedDB (조건부)

  localStorage: 실시간 오더/요청 큐 (만료 시 공격적 삭제)
  IndexedDB: 에스크로 책임이 있는 오더 (유동성 검증 완료 이후)

Customer/Sponsor:
  kind 30402 구독 → 서비스 레이어 → localStorage → UI (자동 리렌더)

  localStorage: 오더 표시 전용 (만료 시 공격적 삭제)
  IndexedDB: 불필요 — Admin이 권위 있는 기록을 보유
```

### 왜 단순해지는가

**현재**: 3개 앱 모두 "내가 관여한 오더"를 각자 보존해야 한다.
→ 각 앱에 IndexedDB 저장 조건, 서비스 레이어 분기, 상태 동기화 로직이 필요하다.

**변경 후**: Admin이 유일한 상태 소유자이므로, **Admin만 IndexedDB를 운영**한다.
→ Customer/Sponsor는 localStorage만 쓰면 되고, 거래 기록이 필요하면 릴레이에서 Admin의 이벤트를 재조회하면 된다.

### Admin의 IndexedDB

**오브젝트 스토어**: `orders` + `requests` (2개)

**orders:**

| 필드 | 타입 | 설명 |
|------|------|------|
| orderId | string (PK) | 주문 ID |
| status | string | `active` \| `sold` (NIP-99 호환) |
| state | string | 세부 오더 상태 |
| customerPubkey | string | 주문 요청자 |
| price | number | 금액 |
| createdAt | number | 생성 시각 |
| updatedAt | number | 최종 갱신 시각 |
| raw | Event | 최신 kind 30402 원본 |

인덱스: `createdAt`, `[state, createdAt]`

**requests:**

| 필드 | 타입 | 설명 |
|------|------|------|
| eventId | string (PK) | Nostr 이벤트 ID (중복 수신 방어) |
| orderId | string | 관련 오더 ID |
| action | string | 요청 종류 (`order-request`, `claim`, `payment-confirm`, ...) |
| pubkey | string | 요청자 pubkey |
| createdAt | number | 생성 시각 |
| raw | Event | kind 1111 원본 |

인덱스: `orderId` (1:M 조회용, 이것만 있으면 충분)

> requests는 항상 특정 orderId 컨텍스트에서만 조회한다.
> 오더 단위 페이지네이션 → 개별 오더 상세 → 해당 오더의 requests 조회 흐름이므로,
> orderId 인덱스 하나면 된다. 정렬은 인메모리로 수행한다.

**데이터 형식**: localStorage와 IndexedDB에 저장하는 레코드 형식은 동일하다. 차이는 IndexedDB에 인덱스가 걸려있다는 것뿐이다.

**저장 조건**: Admin FSM의 특정 상태 전이 시점에 해당 orderId의 오더와 requests를 일괄 이동한다. 구체적 트리거는 구현 시 확정하되, 에스크로 책임이 시작되는 시점이 될 것이다.

**동기화 전략**: 초기 이동 이후에는 localStorage 쓰기 시 IndexedDB를 연동한다.

1. localStorage에 오더 또는 request가 upsert될 때
2. 해당 orderId로 IndexedDB `orders` 스토어를 조회한다
3. 존재하면 → 관리 대상으로 판단하여 IndexedDB에도 반영 (오더는 upsert, request는 upsert)
4. 존재하지 않으면 → 무시 (아직 관리 대상이 아님)

> request의 upsert는 eventId(PK)를 키로 한다. 릴레이에서 같은 이벤트가 중복 수신될 수 있으므로 insert가 아닌 upsert여야 한다.

### Admin의 localStorage

현재와 유사하게 실시간 오더/요청 큐로 사용한다.
만료된 오더와 연관 요청을 공격적으로 삭제한다 (상태 무관 — 보존할 것은 IndexedDB에 있으므로).

### Sponsor의 localStorage

오더북 표시 전용. 읽기 전용 성격이 강해진다.
오더의 상태는 Admin이 발행한 값을 그대로 저장하므로, 로컬 FSM이 사라지고 `upsertOrder()`가 단순해진다.
만료된 오더를 공격적으로 삭제한다.

**Sponsor의 거래 기록 필요 시**: Nostr 릴레이에서 Admin의 kind 30402를 재조회하면 된다.
Sponsor 자신의 kind 1111 이벤트(클레임 등)는 릴레이에 서명과 함께 남아있으므로 분쟁 시 증거로 사용 가능하다.

### Customer의 chrome.storage.local

기존과 동일하게 자기 주문만 저장한다.
추가로 Admin의 kind 30402를 구독하여 자기 오더의 최신 상태를 반영한다.

### 히스토리 UI (Admin 전용)

- IndexedDB 데이터를 보는 별도 화면
- 자동 리렌더링 없음 — 페이지 진입/새로고침 시에만 fetch
- 커서 기반 페이지네이션 (이전/다음 버튼만)
- 상태 필터 지원 (복합 인덱스 `[state, createdAt]` 활용)

---

## 7. 구현 순서 (큰 틀)

아키텍처 전환과 저장소 이중화를 동시에 하면 범위가 너무 크다.
단계적으로 진행하되, 각 단계가 독립적으로 동작 가능해야 한다.

### Phase 1: Admin 중심 이벤트 모델 전환 — 완료

- Admin: kind 30402 발행/갱신 기능 구현, kind 1111 요청 수신 구독 추가
- Admin: 단일 FSM 구현 (기존 3개 FSM 통합)
- Customer: kind 30402 → kind 1111 `order-request`로 전환, Admin 오더 구독 추가
- Sponsor: 로컬 FSM 제거, Admin 오더 상태를 그대로 표시
- PROTOCOL.md 전면 갱신

### Phase 2: localStorage 삭제 전략 단순화 — 완료

- Admin: 만료 오더 + 연관 요청 공격적 삭제 (`cleanup.ts` 스케줄러, 60초 주기)
- Sponsor: 만료 오더 공격적 삭제 (`order-store.ts` 내장 스케줄러, 60초 주기)
- 삭제 기준: `expiration > 0 && expiration <= now` (상태 무관)
- 앱 시작 시 즉시 1회 실행 + 주기적 반복

### Phase 3: Admin IndexedDB 도입

- IndexedDB 스토어 + API 구현
- 에스크로 진입 시 IndexedDB 저장 로직
- 히스토리 UI 구현

---

## Appendix: localStorage 한계 분석

> 이 절은 아키텍처 전환과 무관하게 적용되는 localStorage의 구조적 한계를 기록한다.

1. **저장 용량 제한**: 브라우저별 5~10MB. 오더 누적 시 한계 도달.
2. **전량 직렬화/역직렬화**: `JSON.stringify(전체맵)` → `localStorage.setItem()`로 매번 전체를 읽고 쓴다. 데이터 증가 시 모든 I/O가 느려진다.
3. **삭제할 수 없는 데이터**: 거래 기록(분쟁 증거)과 만료 오더가 같은 저장소에 섞여 삭제 전략이 복잡해진다.
4. **만료 필터링의 한계**: UI에서 필터링해도 데이터 자체는 남아 공간을 소모한다.

IndexedDB로 분리하면:
- 용량 제한이 사실상 해소된다 (수백 MB~GB)
- 인덱스 기반 부분 조회가 가능하다 (전량 직렬화 불필요)
- 삭제 전략이 단순해진다 (localStorage는 무조건 만료 삭제, IndexedDB는 장기 보존)

---

## 관련 문서

- [ARCHITECTURE.md](ARCHITECTURE.md) — 전체 시스템 아키텍처
- [PROTOCOL.md](PROTOCOL.md) — Nostr 이벤트 프로토콜 명세
- [TODO.md](TODO.md) — 향후 구현 계획

---

**Last Updated**: 2026-02-21
