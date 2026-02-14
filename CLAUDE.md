# CLAUDE.md

이 파일은 AI 코딩 어시스턴트가 이 코드베이스를 다룰 때 참조하는 지침이다.

## 프로젝트 요약

비트코인 P2P 거래 에스크로 플랫폼 "사줘 트래커".
Customer(BTC로 물건 구매)와 Sponsor(KRW→BTC 환전)를 Nostr로 연결한다.
Admin이 에스크로(Lightning 유동성 검증, 분쟁 중재)를 제공한다.

## 빌드 & 실행

```bash
pnpm install                          # 의존성 설치
pnpm build:customer                   # Customer Chrome Extension 빌드
pnpm build:sponsor                    # Sponsor React SPA 빌드
pnpm dev:customer                     # Customer 개발 서버
pnpm dev:sponsor                      # Sponsor 개발 서버 (port 5174)
pnpm admin:emit                       # 테스트 이벤트 발행
pnpm admin:emit -- --price 50000 --exp 3600  # 옵션 지정
pnpm admin:sold -- <orderId>          # sold 이벤트 발행
```

## 헌법 (반드시 준수)

### 저장소 구독 패턴 — 최우선 원칙

모든 코드 수정 시 이 패턴을 반드시 준수해야 한다:

```
Nostr 릴레이 → Nostr 서비스 (백그라운드) → 영구 저장소 → UI
```

1. **UI는 Nostr 릴레이를 절대 직접 참조하지 않는다.**
   UI는 영구 저장소(chrome.storage.local, localStorage)만 구독하고,
   저장소 변경 시 자동으로 리렌더링한다.

2. **Nostr 서비스가 백그라운드에서 릴레이를 구독한다.**
   이벤트 수신/발행은 UI와 독립된 서비스 레이어에서 수행하고,
   변경사항은 영구 저장소에 반영하여 UI에 자동 전파한다.

3. **구독 서비스와 UI의 생명주기는 독립적이다.**

이 패턴을 위반하는 코드(예: UI 컴포넌트에서 SimplePool 직접 사용)는 절대 작성하지 않는다.

## 레포지토리 구조

```
sajwo-tracker/              ← pnpm workspace 모노레포
  shared/                   ← @sajwo-tracker/shared (Nostr 공통: 키, 릴레이, 상수, 타입)
  customer/                 ← @sajwo-tracker/customer (Chrome Extension MV3)
  sponsor/                  ← @sajwo-tracker/sponsor (React 19 SPA)
  admin/                    ← @sajwo-tracker/admin (Node.js CLI 테스트 도구)
  ARCHITECTURE.md           ← 시스템 아키텍처 상세
  PROTOCOL.md               ← Nostr 이벤트 프로토콜 명세
  TODO.md                   ← 향후 구현 계획
```

## 핵심 아키텍처 결정

- **Nostr 프로토콜**: 탈중앙화 P2P 통신. kind 30402 (NIP-99 Classified Listing) addressable event 사용.
- **StorageAdapter 패턴**: chrome.storage.local과 localStorage의 차이를 인터페이스로 추상화.
- **상태 머신**: 에스크로 거래의 상태 전이를 FSM + optimistic locking으로 관리.
- **pubkey 검증**: 같은 orderId라도 최초 발행자만 갱신/삭제 가능.
- **NIP-65 Outbox Model**: Customer → 앱 read relay에 write, Sponsor → 같은 relay에서 read.
- **shared 패키지**: TypeScript 소스 직접 export, 각 앱의 Vite가 컴파일.

## 앱별 데이터 흐름

### Customer (Chrome Extension)
```
content/index.ts (쿠팡 파싱) → shared/storage.ts (chrome.storage.local) → popup/dashboard (onChanged 리스너)
background/index.ts (Nostr 발행) ← PUBLISH_ORDER 메시지 ← popup/dashboard/content
```

### Sponsor (React SPA)
```
nostr/service.ts (릴레이 구독) → order-store.ts (localStorage + notify) → OrderBook (useSyncExternalStore)
```

## 코딩 규칙

- TypeScript strict 모드. `any` 금지.
- Nostr 코드는 각 앱의 `nostr/` 디렉토리에 모듈화.
- 이벤트에는 반드시 `expiration` 태그 포함 (릴레이 찌꺼기 방지).
- 빌드 확인: 코드 수정 후 `pnpm build:customer && pnpm build:sponsor` 통과 필수.

## 주요 참고 문서

- [ARCHITECTURE.md](ARCHITECTURE.md) — 전체 시스템 구조, 거래 흐름, 에스크로 역할
- [PROTOCOL.md](PROTOCOL.md) — Nostr 이벤트 명세, 태그 구조, 구독 필터, 클레임 흐름
- [TODO.md](TODO.md) — 미구현 기능 목록
- [.specify/memory/constitution.md](.specify/memory/constitution.md) — 개발 헌법 상세
