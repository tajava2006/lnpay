# 영구저장소 이중화 전략: localStorage + IndexedDB

> 상태: **설계 검토 중** | 작성일: 2026-02-18

## 목차

- [1. 문제 정의](#1-문제-정의)
- [2. 제안: 이중 저장소 구조](#2-제안-이중-저장소-구조)
- [3. localStorage — 오더북 UI 전용](#3-localstorage--오더북-ui-전용)
- [4. IndexedDB — 거래 히스토리 보존](#4-indexeddb--거래-히스토리-보존)
- [5. 삭제 전략](#5-삭제-전략)
- [6. 히스토리 UI](#6-히스토리-ui)
- [7. 검토 의견 및 우려 사항](#7-검토-의견-및-우려-사항)
- [8. 미결정 사항](#8-미결정-사항)

---

## 1. 문제 정의

### 현재 구조

모든 앱(Customer, Sponsor, Admin)이 **localStorage 단일 저장소**를 사용한다.
Nostr 구독이 localStorage에 반영하고, UI는 localStorage를 구독한다.

```
Nostr 릴레이 → 서비스 레이어 → localStorage → UI (useSyncExternalStore)
```

### 문제점

**localStorage의 구조적 한계가 장기 운영 시 문제를 일으킨다:**

1. **저장 용량 제한**: 브라우저별로 5~10MB. 오더가 누적되면 한계에 도달한다.

2. **전량 직렬화/역직렬화**: 현재 `JSON.stringify(전체맵)` → `localStorage.setItem()`으로 매번 전체 데이터를 읽고 쓴다. 데이터가 늘수록 모든 읽기/쓰기 연산이 느려진다.

3. **삭제할 수 없는 데이터의 존재**: 만료된 오더를 공격적으로 삭제하면 저장 용량 문제는 완화되지만, 삭제하면 안 되는 데이터가 있다:
   - **Sponsor**: 내가 클레임한 오더 — 결제까지 진행된 거래 기록, 분쟁 발생 시 증거
   - **Admin**: 유동성 검증 완료 후 고객에게 입금 신호를 보낸 오더 — 에스크로 책임이 있는 거래

4. **만료 기반 필터링의 한계**: 현재 UI에서 만료된 오더를 필터링하여 보여주지 않지만, 데이터 자체는 localStorage에 남아있어 저장 공간을 소모한다. 새 유저는 만료 태그(`expiration`)로 과거 이벤트를 받지 않지만, 오래 사용한 유저의 데이터는 줄어들지 않는다.

5. **삭제 전략의 복잡성**: "이 오더는 상태가 X이니까 지우면 안 된다"는 판단을 삭제 로직에 넣으면 복잡해진다. 저장하면 안 되는 것과 저장해야 하는 것을 같은 저장소에 두는 것이 근본 원인이다.

### Customer 앱은 이 문제에서 제외

Customer는 **자기가 생성한 주문만** 저장한다. 타인의 데이터를 구독하지 않으므로 데이터 폭증이 구조적으로 발생하지 않는다. 주문이 너무 많으면 유저가 수동으로 완료/취소된 주문을 삭제할 수 있다.

---

## 2. 제안: 이중 저장소 구조

```
Nostr 릴레이 → 서비스 레이어 ─┬→ localStorage (오더북 UI)
                              └→ IndexedDB   (거래 히스토리) ← 조건부 저장
```

| 저장소 | 역할 | 데이터 수명 | UI 갱신 |
|--------|------|------------|---------|
| localStorage | 실시간 오더북 | 짧음 (만료 시 공격적 삭제) | `useSyncExternalStore` 자동 리렌더 |
| IndexedDB | 거래 히스토리 보존 | 장기 (유저 수동 삭제만 허용) | 수동 (페이지 진입/새로고침 시 fetch) |

### 핵심 원칙

- **localStorage는 기존 그대로 유지한다.** 구조 변경 없음. 오더북 실시간성을 위한 전용 저장소.
- **IndexedDB는 "지우면 안 되는 데이터"만 저장한다.** 조건을 충족하는 시점에 저장.
- **두 저장소는 독립적으로 운영된다.** localStorage 삭제가 IndexedDB에 영향을 주지 않고, 그 역도 마찬가지.
- **localStorage 삭제 전략이 단순해진다.** 상태에 따른 삭제 보호가 불필요해진다 — 보존할 데이터는 이미 IndexedDB에 있으므로.

---

## 3. localStorage — 오더북 UI 전용

기존 코드를 변경하지 않는다. 달라지는 점은 **삭제 전략의 단순화**뿐이다.

### Sponsor 앱

- 저장소: `localStorage('nostr:orders')` — `Record<string, SajwoRequest>`
- 기존: 삭제 시 상태 확인 없음 (sold 이벤트 수신 시만 삭제)
- 변경: 만료된 오더를 백그라운드에서 공격적으로 삭제 (상태 무관)

### Admin 앱

- 저장소: `localStorage('admin:orders')` + `localStorage('admin:claims')`
- 기존: 오더는 sold 시 삭제, 클레임은 삭제 없음
- 변경: 만료된 오더 + 연관 클레임을 백그라운드에서 공격적으로 삭제

---

## 4. IndexedDB — 거래 히스토리 보존

### 테이블 설계

**오직 하나의 오브젝트 스토어(테이블)**로 단순화한다.

```
Object Store: "orders"
─────────────────────────────
Primary Key: orderId (string)

필드:
  orderId      string          — PK
  status       string          — 거래 상태
  price        number          — 금액 (KRW)
  currency     string          — 통화
  createdAt    number          — 이벤트 생성 시각 (unix seconds)
  expiresAt    number | null   — 만료 시각
  updatedAt    number          — 마지막 업데이트 시각 (unix ms)
  claims       ClaimSummary[]  — 연관 클레임 (비정규화, Admin 전용)
  raw          Event           — 원본 Nostr 이벤트
  ...앱별 추가 필드
```

### 인덱스

| 인덱스 이름 | 키 | 용도 |
|------------|-----|------|
| `by-time` | `createdAt` | 시간역순 페이지네이션 |
| `by-status-time` | `[status, createdAt]` | 특정 상태의 오더만 시간역순 조회 |

다른 인덱스는 추가하지 않는다. orderId 조회는 PK로 커버된다.

### 비정규화: 클레임을 오더에 내장

Admin 앱에서 클레임 데이터는 오더 행의 `claims` 칼럼에 리스트로 들어간다.

```typescript
interface ClaimSummary {
  claimId: string;
  sponsorPubkey: string;
  bolt11: string;
  status: AdminClaimStatus;      // 'pending' | 'approved' | 'rejected'
  liquidityVerified: boolean;
  createdAt: number;
}
```

정규화 위반이지만 다음 이유로 허용:
- 조인이 없어 쿼리가 단순하다.
- 한 오더에 달리는 클레임 수는 소수(1~5개)로 제한적이다.
- 테이블이 하나뿐이므로 스키마가 단순하다.

### IndexedDB 저장 조건

**Sponsor 앱:**
- **저장 시점**: 내가 클레임을 발행한 시점
- **저장 대상**: 해당 오더 데이터
- **이후 업데이트**: 어드민에서 선택받았을 때(selected), 클레임 정보가 오더의 `claims` 칼럼에 추가됨

**Admin 앱:**
- **저장 시점**: 유동성 검증을 완료하고 고객에게 입금 신호를 보낸 시점
- **저장 대상**: 해당 오더 + 연관 클레임 데이터
- **이유**: 그 단계 이전의 데이터는 에스크로 책임이 없으므로 보존 불필요
- **데이터 최소화**: 클레임을 받았더라도 유동성 검증 미완료면 저장하지 않음

---

## 5. 삭제 전략

### Sponsor 앱

```
백그라운드 (setInterval 또는 앱 시작 시)
  ↓
localStorage('nostr:orders')에서 expiresAt < now인 오더를 수집
  ↓
전부 삭제 (상태 무관 — IndexedDB에 보존할 것은 이미 저장됨)
```

### Admin 앱

```
백그라운드 (setInterval 또는 앱 시작 시)
  ↓
localStorage('admin:orders')에서 expiresAt < now인 오더를 수집
  ↓
해당 오더의 orderId로 localStorage('admin:claims')에서 연관 클레임 수집
  ↓
오더 + 연관 클레임 전부 삭제
```

### Customer 앱

변경 없음. 자기 데이터만 저장하며 수동 삭제로 관리한다.

---

## 6. 히스토리 UI

IndexedDB 데이터를 보는 **별도의 화면**을 구성한다.

### 설계 원칙

- **자동 리렌더링 없음**: `useSyncExternalStore` 패턴을 사용하지 않는다. IndexedDB 데이터는 실시간성이 필요 없다.
- **데이터 fetch**: 페이지 진입 시 또는 새로고침 시에만 IndexedDB에서 읽어온다.
- **페이지네이션**: 1, 2, 3... 페이지 번호가 아닌, **이전/다음 버튼만** 있는 커서 기반 페이지네이션.

### 화면 구성

1. **오더 목록**: 시간 역순, 페이지네이션 (커서 기반)
   - 상태 필터 지원 (복합 인덱스 `[status, createdAt]` 활용)
2. **오더 상세**: 목록에서 클릭 시 표시
   - Admin: 내장된 클레임 리스트 포함

### 커서 기반 페이지네이션

```typescript
// 다음 페이지: 현재 페이지의 마지막 createdAt보다 이전 것을 가져옴
const range = IDBKeyRange.upperBound(lastCreatedAt, true);  // exclusive
cursor.openCursor(range, 'prev');  // 시간 역순
```

- 총 개수 계산 불필요 (IndexedDB에서 count는 비쌈)
- 다음/이전 버튼만으로 탐색
- IndexedDB 커서 연산에 최적화된 패턴

---

## 7. 검토 의견 및 우려 사항

### 7.1 서비스 레이어 복잡도 증가

**현재 (단일 저장소):**
```
Nostr → 서비스 레이어 → localStorage → UI
```

**변경 후 (이중 저장소):**
```
Nostr → 서비스 레이어 ─┬→ localStorage (항상)
                       └→ IndexedDB   (조건부)
```

서비스 레이어가 "이 이벤트는 IndexedDB에도 써야 하는가?"를 판단해야 한다.

- Sponsor: `upsertOrder()` 시에는 localStorage만, `claim()` 시에는 IndexedDB에도 저장
- Admin: 유동성 검증 완료 + 입금 신호 시점에 IndexedDB 저장

**대응 방안**: IndexedDB 저장 로직은 서비스 레이어가 아닌 **액션 핸들러**(클레임 발행, 유동성 검증 완료 등)에서 호출한다. 서비스 레이어(Nostr 구독)는 여전히 localStorage만 다루므로 기존 패턴을 위반하지 않는다.

다만, 상태가 진행된 후의 업데이트(예: Sponsor에서 `selected` 이벤트 수신 → IndexedDB 오더의 claims 칼럼 업데이트)는 서비스 레이어에서 IndexedDB에 접근해야 한다. 이 부분은 기존 패턴에서 예외가 된다.

### 7.2 localStorage ↔ IndexedDB 데이터 일관성

한 오더가 동시에 두 저장소에 존재할 수 있다 (localStorage에서 아직 만료 삭제 안 됨 + IndexedDB에 이미 저장됨). 이때:

- **상태 불일치 가능**: localStorage의 상태와 IndexedDB의 상태가 다를 수 있다. localStorage는 Nostr 이벤트로 계속 업데이트되지만, IndexedDB는 특정 시점에만 업데이트되므로.
- **해결**: 두 저장소의 목적이 다르므로 불일치를 문제로 보지 않는다. localStorage는 "지금 진행 중인 오더북", IndexedDB는 "나의 거래 기록"이다. 오더북 UI와 히스토리 UI가 분리되어 있으므로 유저가 혼란을 겪을 가능성이 낮다.

### 7.3 Sponsor의 "선택 시 클레임 정보 돌려받기" 메커니즘

Sponsor가 클레임한 시점에 오더를 IndexedDB에 저장하되, **클레임 정보는 저장하지 않고** 어드민에서 선택받았을 때 돌려받는 설계다.

**우려**: 이 "돌려받기" 메커니즘이 현재 프로토콜에 구현되어 있지 않다. Sponsor의 Nostr 구독은 kind 30402 (오더)와 kind 1111 (클레임)을 수신하지만, 어드민 → Sponsor 방향의 알림 프로토콜이 아직 없다.

**대응 방안**: 이 기능은 미래 프로토콜 확장과 함께 구현된다. 당장은 Sponsor IndexedDB에 오더만 저장하고, claims 칼럼은 비워둔다. 알림 메커니즘이 구현될 때 채워넣는다.

### 7.4 브라우저 데이터 소실 위험

IndexedDB도 브라우저 저장소이므로, 유저가 "사이트 데이터 삭제"를 하면 히스토리가 사라진다.

**심각도**: 중간. 거래 기록이 영구적으로 필요한 경우(분쟁 증거 등) 브라우저 저장소만으로는 충분하지 않다.

**대응 방안** (향후):
- 히스토리 내보내기(JSON export) 기능
- 또는 Nostr 릴레이 자체가 히스토리 저장소 역할 (이벤트가 릴레이에 남아있으므로 재구독으로 복원 가능)

지금 당장은 이 위험을 수용한다. 릴레이에 원본 이벤트가 남아있으므로 최악의 경우 재구독으로 복원할 수 있다.

### 7.5 기존 유저 데이터 마이그레이션

이 기능을 배포할 때, 기존 유저의 localStorage에 있는 "지우면 안 되는 오더"는 IndexedDB로 마이그레이션되지 않는다.

**대응 방안**: 기존 유저 수가 소수이고 운영 초기이므로, 마이그레이션 없이 배포한다. 이후 새로운 조건 충족 오더부터 IndexedDB에 쌓인다. 필요시 Nostr 릴레이에서 과거 이벤트를 재구독하여 복원할 수 있다.

### 7.6 IndexedDB 비동기 특성과 기존 패턴의 충돌

현재 Sponsor/Admin의 store는 동기 localStorage 기반이다. IndexedDB는 **모든 연산이 비동기**이므로:

- 기존 동기 store 패턴(`loadFromStorage()` → 모듈 초기화 시 즉시 로드)을 IndexedDB에 적용할 수 없다.
- IndexedDB store는 별도의 비동기 API로 설계해야 한다.

**대응 방안**: 히스토리 UI가 `useSyncExternalStore`를 사용하지 않으므로, 비동기 API가 자연스럽다. 컴포넌트 마운트 시 `useEffect` + `useState`로 데이터를 비동기 로드한다.

### 7.7 삭제 타이밍과 데이터 유실

공격적 삭제가 IndexedDB 저장보다 먼저 실행되면 데이터가 유실될 수 있는가?

- **Sponsor**: 클레임 액션이 IndexedDB 저장을 트리거한다. 클레임은 유저의 명시적 행동이고, 이 시점에 즉시 IndexedDB에 쓴다. 백그라운드 삭제가 만료된 오더만 삭제하므로, 클레임할 수 있는 오더(만료 전)는 삭제 대상이 아니다. **타이밍 문제 없음.**
- **Admin**: 유동성 검증 완료 시 IndexedDB에 쓴다. 마찬가지로, 검증 중인 오더는 아직 만료 전이므로 삭제 대상이 아니다. **타이밍 문제 없음.**

단, 만료 직전에 클레임/검증이 진행 중인 극단적 케이스가 있을 수 있다. 이를 방어하려면 삭제 시 "N분 이상 만료된 오더만" 삭제하는 여유를 두면 된다.

---

## 8. 미결정 사항

### 8.1 Sponsor → Admin 알림 프로토콜

Sponsor가 `selected` 등의 상태 변화를 어떻게 전달받는지가 미정. 이 프로토콜이 확정되어야 IndexedDB의 claims 칼럼 업데이트 로직을 구현할 수 있다.

### 8.2 히스토리 내보내기

브라우저 데이터 소실에 대비한 JSON export 기능의 필요 여부와 우선순위.

### 8.3 삭제 주기

백그라운드 클린업의 실행 주기 (앱 시작 시 1회? 주기적? `requestIdleCallback`?).

### 8.4 페이지 크기

히스토리 페이지네이션의 페이지당 항목 수.

### 8.5 IndexedDB 데이터베이스/스토어 이름

앱별 데이터베이스 이름 규칙.

---

## 관련 문서

- [ARCHITECTURE.md](ARCHITECTURE.md) — 전체 시스템 아키텍처
- [PROTOCOL.md](PROTOCOL.md) — Nostr 이벤트 프로토콜 명세
- [TODO.md](TODO.md) — 향후 구현 계획

---

**Last Updated**: 2026-02-18
