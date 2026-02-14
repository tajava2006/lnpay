# 사줘 트래커 시스템 Constitution

## 시스템 개요

비트코인으로 상품을 결제하고 싶은 사람(Customer)과, 거래소 없이 P2P로 BTC를 매수하고 싶은 사람(Sponsor)을
Nostr 릴레이를 통해 연결하는 에스크로 거래 플랫폼이다.

- Customer: 쿠팡 무통장입금 주문을 발행하고 BTC를 지불
- Sponsor: 무통장입금을 대행하고 BTC를 수령
- Admin: 에스크로 서비스 (Lightning 인바운드 유동성 검증, 분쟁 중재)

상세: [ARCHITECTURE.md](../../ARCHITECTURE.md), [PROTOCOL.md](../../PROTOCOL.md)

## 레포지토리 구조

pnpm workspace 모노레포. 4개의 패키지로 구성:
- `shared/` — Nostr 공통 모듈 (키, 릴레이, 상수, 타입)
- `customer/` — Chrome Extension (MV3)
- `sponsor/` — React 19 SPA
- `admin/` — Node.js CLI (향후 에스크로 서비스)

## 핵심 원칙

### I. 저장소 구독 패턴 (최우선 원칙)

**모든 앱에서 반드시 준수해야 하는 데이터 흐름 패턴:**

```
Nostr 릴레이 ──→ Nostr 서비스 (백그라운드) ──→ 영구 저장소 ──→ UI
                 (이벤트 구독/발행)              (변경 반영)     (변경 감지 → 리렌더)
```

1. **UI는 Nostr 릴레이를 절대 직접 참조하지 않는다.**
   UI는 각 앱의 영구 저장소(chrome.storage.local, localStorage 등)만 구독하며,
   저장소에 변경이 발생하면 자동으로 리렌더링한다.

2. **Nostr 서비스가 백그라운드에서 릴레이를 구독한다.**
   Nostr 관련 이벤트 수신/발행은 UI와 독립된 서비스 레이어에서 수행한다.
   수신한 이벤트의 변경사항은 영구 저장소에 반영하고,
   저장소의 변경 알림 메커니즘이 자동으로 UI에 전파한다.

3. **구독 서비스와 UI의 생명주기는 독립적이다.**
   컴포넌트 마운트/언마운트와 무관하게 구독이 유지된다.

이 패턴의 이점:
- 관심사 분리 (Nostr 통신 ↔ UI 렌더링)
- 오프라인 지원 (저장소에 캐시된 데이터로 즉시 표시)
- 테스트 용이성 (저장소 모킹만으로 UI 테스트 가능)

### II. TypeScript Strict

모든 코드는 TypeScript strict 모드로 작성한다.
- `any` 타입 사용 금지 (불가피한 경우 `unknown` + 타입 가드)
- 모든 소스 파일은 `.ts` 또는 `.tsx`

### III. Nostr 이벤트 보안

- pubkey 기반 이벤트 검증: 같은 orderId(d-tag)라도 최초 발행자의 pubkey만 갱신/삭제 허용
- 개인키는 영구 저장소에 안전하게 보관
- Nostr 관련 코드는 각 앱의 `nostr/` 디렉토리에 모듈화
- 이벤트 프로토콜 상세: [PROTOCOL.md](../../PROTOCOL.md)

### IV. 상태 머신 기반 주문 관리

에스크로 거래이므로 상태 전이의 정확성이 중요하다.
- 유한상태머신(FSM)으로 허용된 상태 전이만 수행
- Optimistic Locking으로 동시성 제어
- 상태 전이 실패 시 자동 재시도 (version mismatch)

### V. Shared 패키지 활용

3개 앱에서 공통으로 사용하는 코드는 `@sajwo-tracker/shared`로 추출한다.
- StorageAdapter 인터페이스로 저장소 계층 추상화
- 키 관리, 릴레이 디스커버리, 상수는 shared에서 관리
- shared는 TypeScript 소스를 직접 export, 각 앱의 Vite가 컴파일

### VI. Manifest V3 (Customer 앱)

Chrome Extension Manifest V3 API를 사용한다.
- Service Worker 기반 background script
- 권한은 필요한 최소한만 요청

## 기술 스택

| 영역 | Customer | Sponsor | Admin | Shared |
|------|----------|---------|-------|--------|
| 프레임워크 | Chrome Extension MV3 | React 19 | Node.js CLI | - |
| 빌드 | Vite + CRXJS | Vite | tsx | (앱에서 컴파일) |
| 저장소 | chrome.storage.local | localStorage | - | StorageAdapter |
| 통신 | Nostr (nostr-tools 2.x) | Nostr | Nostr | Nostr |
| 패키지 관리 | pnpm workspace | pnpm workspace | pnpm workspace | pnpm workspace |

**Version**: 2.0.0 | **Last Amended**: 2026-02-14
