# CLAUDE.md

이 파일은 AI 코딩 어시스턴트가 이 코드베이스를 다룰 때 참조하는 지침이다.

## 프로젝트 요약

비트코인 P2P 거래 에스크로 플랫폼 "사줘 트래커".
Customer(BTC로 물건 구매)와 Sponsor(KRW→BTC 환전)를 Nostr로 연결한다.
Admin이 에스크로(Lightning 유동성 검증, 분쟁 중재)를 제공한다.

## 빌드 & 실행

```bash
pnpm install                          # 의존성 설치
pnpm build:customer                   # Customer 웹앱 빌드
pnpm build:sponsor                    # Sponsor React SPA 빌드
pnpm build:admin                      # Admin React SPA 빌드
pnpm build:userscript                 # 유저스크립트 빌드 (prod)
pnpm build:userscript:dev             # 유저스크립트 빌드 (dev, CLIENT_TAG=sajwo-tracker-dev)
pnpm dev:customer                     # Customer 개발 서버
pnpm dev:sponsor                      # Sponsor 개발 서버 (port 5174)
pnpm dev:admin                        # Admin 개발 서버
```

## 헌법 (반드시 준수)

### 저장소 구독 패턴 — 최우선 원칙

모든 코드 수정 시 이 패턴을 반드시 준수해야 한다:

```
Nostr 릴레이 → Nostr 서비스 (백그라운드) → 영구 저장소 → UI
```

1. **UI는 Nostr 릴레이를 절대 직접 참조하지 않는다.**
   UI는 영구 저장소(localStorage)만 구독하고,
   저장소 변경 시 자동으로 리렌더링한다.

2. **Nostr 서비스가 백그라운드에서 릴레이를 구독한다.**
   이벤트 수신/발행은 UI와 독립된 서비스 레이어에서 수행하고,
   변경사항은 영구 저장소에 반영하여 UI에 자동 전파한다.

3. **구독 서비스와 UI의 생명주기는 독립적이다.**

이 패턴을 위반하는 코드(예: UI 컴포넌트에서 SimplePool 직접 사용)는 절대 작성하지 않는다.

## 레포지토리 구조

```
sajwo-tracker/                ← pnpm workspace 모노레포
  shared/                     ← @sajwo-tracker/shared (Nostr 공통: 키, 릴레이, 상수, 타입)
  customer/                   ← @sajwo-tracker/customer (React 19 SPA + Tampermonkey 유저스크립트)
  customer/userscript/        ← 쿠팡 자동파싱 유저스크립트 (esbuild IIFE 번들)
  sponsor/                    ← @sajwo-tracker/sponsor (React 19 SPA)
  admin/                      ← @sajwo-tracker/admin (React 19 SPA, 순수 프론트엔드 에스크로)
```

## 핵심 설계 요약

- kind 30402 (NIP-99 addressable event)로 오더, kind 1111 (NIP-22 comment)로 요청
- Admin이 유일한 FSM/상태 소유자 (발행 우선 패턴: publish → 릴레이 에코로 로컬 반영)
- StorageAdapter 인터페이스로 localStorage 추상화
- shared 패키지는 TS 소스 직접 export → 각 앱의 Vite가 컴파일
- 순수 프론트엔드 배포 (Admin: NIP-46 인증, NIP-78+NIP-44 암호화 설정)
- Lightning 노드 REST API 브라우저 직접 호출 (nginx Let's Encrypt 프록시 경유)
- NIP-65 Outbox Model: 비즈니스 이벤트 → 읽기 릴레이, Admin 전용 → 쓰기 릴레이

## 코딩 규칙

- TypeScript strict 모드. `any` 금지.
- Nostr 코드는 각 앱의 `nostr/` 디렉토리에 모듈화.
- 이벤트에는 반드시 `expiration` 태그 포함 (릴레이 찌꺼기 방지). **예외: `dispute-message` 이벤트는 분쟁 증거 보존 목적으로 만료 없음.**
- 빌드 확인: 코드 수정 후 `pnpm build:customer && pnpm build:sponsor && pnpm build:admin` 통과 필수.
- Dev/Prod 데이터 격리: `CLIENT_TAG`가 dev(`sajwo-tracker-dev`) / prod(`sajwo-tracker`)로 분리.
- Dev 전용 코드는 `dev-only/` 디렉토리에 파일 단위로 격리하고, `import.meta.env.DEV` 가드 내에서만 import.

## 문서 가이드

작업 내용에 따라 필요한 문서만 참조한다:

| 문서 | 줄 수 | 참조 시점 |
|------|-------|----------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | ~540 | 앱별 모듈 구조, 데이터 흐름, 저장소 이중화, 설계 결정 이해 필요 시 |
| [PROTOCOL.md](PROTOCOL.md) | ~620 | Nostr 이벤트 kind/tag, 상태 머신(FSM) 전이 규칙, 구독 필터 확인 시 |
| [THREAT-MODEL.md](THREAT-MODEL.md) | ~120 | FSM 전이 변경, 권한 변경, 새 action 추가 시 어뷰징/레이스컨디션 방어 확인 |
| [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md) | ~250 | 보안/아키텍처 개선 항목 추적, 우선순위별 해결 계획 |
| [TODO.md](TODO.md) | ~80 | 미구현 기능 목록 확인 시 |
