# CLAUDE.md

이 파일은 AI 코딩 어시스턴트가 이 코드베이스를 다룰 때 참조하는 지침이다.

## 프로젝트 요약

비트코인 ↔ 원화 P2P 에스크로 "페어바이". 고객과 후원자를 nostr로 잇고, **운영 PC의 데몬 하나**가 에스크로
에이전트로서 판단·집행을 전부 한다. 트랙은 둘이다:

- **라이트닝** — 쿠팡 대리결제. 에스크로 = 데몬 LND의 홀드 인보이스.
- **온체인** — non-KYC 직거래. 에스크로 = 2-of-3 taproot(고객·후원자·어드민) + 고객 단독 타임락 리프.

유저 앱은 **한 앱·한 키**로 두 역할(고객·후원자)을 겸한다. 역할은 오더의 `customerPubkey`·`sponsorPubkey`와 내
pubkey를 비교해 유도한다 — 저장된 역할 칼럼이 없다. 어드민 앱은 운영자 키로 명령만 보내는 **리모컨**이다.

## 문서 — 작업 전에 해당하는 것만 읽는다

| 문서 | 언제 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 데몬 구조·불변조건(DM-001~009)·명령 채널·유저 앱 구조. **데몬·어드민 코드를 만질 때** |
| [docs/LN-TRACK.md](docs/LN-TRACK.md) | 라이트닝 FSM·닫기 사유 → 돈·시간 값과 부등식·불변조건(I-xxx) |
| [docs/ONCHAIN-TRACK.md](docs/ONCHAIN-TRACK.md) | 온체인 스크립트·FSM·서명 순서·수수료·시간·불변조건(O-xxx) |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | 이벤트 kind(왜 그 kind인지)·태그·요청/통지 action·구독 필터·운영자 DM |
| [docs/RISKS.md](docs/RISKS.md) | **불안한 점 전부** — 열린 위험(R-xx)·신뢰 모델·공격 표(T-xxx)·변경 전 체크리스트. 새로 발견하면 여기 추가 |
| [docs/DAEMON-DEPLOY.md](docs/DAEMON-DEPLOY.md) | 운영 런북(데몬 배포·앱 배포·감시). 배포할 때 **먼저** |
| [docs/ONCHAIN-SIGNET-DRILL.md](docs/ONCHAIN-SIGNET-DRILL.md) | signet 드릴 런북 |

**문서의 진실은 코드다.** 표와 코드가 어긋나면 코드가 맞고 문서를 고친다. 시간 값 사이의 부등식은
`daemon/src/__tests__/timing-invariants.test.ts`가 지킨다 — 값을 바꾸면 트랙 문서의 표도 같이 고친다.

## 빌드 & 실행

```bash
pnpm install
pnpm verify                  # 전 패키지 타입체크 + 린트 + 테스트 (CI와 같다)
pnpm lint                    # oxlint --type-aware — 훅 규칙·버린 promise (깨끗하면 아무것도 안 찍는다)
pnpm verify:web              # 데몬 제외 (VPS의 ship이 쓴다)
pnpm build:customer          # 통합 유저 앱
pnpm build:admin             # 어드민 앱 (리모컨)
pnpm build:daemon            # 데몬 번들 daemon/dist/daemon.mjs (운영은 docker가 빌드)
pnpm build:userscript        # 쿠팡 유저스크립트 (prod) — :dev는 CLIENT_TAG가 -dev
pnpm build:sponsor           # 옛 후원자 도메인 리다이렉트
pnpm dev:customer · dev:admin          # -dev 태그 — signet 드릴 데몬(LNPAY_MODE=dev)과만 만난다
pnpm preview:customer · preview:admin  # prod 빌드를 로컬(4174·4173)에서 — 운영 데몬과 만난다
pnpm ship                    # VPS 배포: pull → 설치 → verify:web → 전 앱 빌드
./update-deps.sh             # 의존성 전부 latest로 + 검증
```

코드를 고친 뒤 `pnpm verify`와 영향받는 앱 빌드가 통과해야 한다. **데몬 코드를 바꿨으면 운영 PC에서 이미지를 다시
빌드해야** 반영된다(`up -d`만으로는 옛 이미지).

의존성은 핀하지 않고 latest를 따라간다 — 최말단 앱이라 깨지면 그때 고치는 게 몇 달치 breaking을 한꺼번에 맞는
것보다 싸다. 예외: 온체인 서명 경로의 `@noble/curves`는 `@scure/btc-signer`와 **같은 버전에 정확히 핀**한다.
단 **막 올라온 버전은 3일 묵힌다**(`pnpm-workspace.yaml`의 `minimumReleaseAge`) — npm 계정 탈취로 올라온 악성
버전이 내려가는 창을 피한다. 유저 앱은 브라우저에 nsec를 들고 있다.

TS 엄격함은 루트 `tsconfig.base.json` 하나다 — 패키지는 target·lib·jsx·types만 정한다.

## 헌법 (반드시 준수)

### 1. 쓰는 곳은 데몬 하나다

상태를 바꾸는 코드는 데몬에만 있다(DM-001). 유저 앱은 요청 이벤트로 **요청만** 하고, 어드민 앱은 **명령만** 보낸다.
어드민 앱에 APP 키·LN 자격증명·집행 코드를 들이지 않는다.

데몬 코드는:
- 핸들러·워처 판단은 **트랜잭션 안에서, 네트워크 없이**. 돈이 움직이는 일은 효과 **의도**로만 쌓는다(DM-002).
- 되돌릴 수 없는 효과가 **확인된 뒤에** 그 결과를 전제한 상태를 발행한다(DM-003).
- 효과 실행기는 **멱등**하게 — 조회 먼저.
- 돈의 처리는 **닫기 사유 표**(`CLOSE_RULES`·`OUTCOME_RULES`)를 거친다. 사유 없이 settle/cancel 하지 않는다.
- shared는 `@sajwo-tracker/shared/core`·`/ln`·`/onchain`으로만 가져간다 — 루트 입구는 React·localStorage를 끌고 온다.

### 2. 유저 앱의 저장소 구독 패턴

```
Nostr 릴레이 → Nostr 서비스 (백그라운드) → 영구 저장소 → UI
```

1. **UI는 Nostr 릴레이를 절대 직접 참조하지 않는다.** 저장소(localStorage·IndexedDB)만 구독한다.
2. Nostr 서비스가 백그라운드에서 구독·발행하고 결과를 저장소에 쓴다.
3. 서비스와 UI의 생명주기는 독립이다.
4. localStorage 저장소는 shared `createStore`(`persisted-store.ts`)로 만든다 — **읽을 때 모양을 본다**(`parse`,
   맵이면 `recordOf`로 항목마다). `JSON.parse(...) as T` 금지. 저장된 값의 뜻이 바뀌면 `version`을 올린다(한 번 비워진다).
   모양 확인은 **받을 때와 같은 가드**를 쓴다 — 둘이 다르면 받은 값이 새로고침에 사라진다.

통합 앱은 `customer/src/nostr/`가 소켓을 단독 소유하고 역할별 핸들러로 팬아웃한다. 역할 모듈은 구독을 직접 만들지
않는다. UI 컴포넌트에서 `SimplePool`을 쓰는 코드는 절대 작성하지 않는다.

### 3. 받은 것은 보낸 사람을 본다

누구나 요청 이벤트(3838)·오더 이벤트(38383, NIP-69 공용 kind)를 쏠 수 있다. 오더는 APP이 서명한 것만, 요청은
그 오더의 그 역할이 보낸 것만 받는다(I-008·O-020). 유저 앱은 데몬이 보낸 것도 믿지 않고 **스스로 다시 만들어 대조한다** — 에스크로 주소(T-107),
서명할 tx(O-021).

## 코딩 규칙

- TypeScript strict. `any` 금지. 주석은 한국어.
- **FSM을 고치면 다섯 가지가 세트다**: 전이 맵 → 알림 문구 → 문서 → 진행도 표시 → 상태 배지. 타입체커가 안 잡아주는
  자리라 매번 빠뜨렸다. 상태 목록 표는 `Record<State, …>`로 못박아 **빌드가 깨지게** 하고, 터미널 목록은 전이 맵에서
  유도한다(`shared/order-display.ts`가 본보기).
- **문구에 숫자를 박지 않는다.** 창 길이는 상수에서 가져온다(`durationText`).
- **"모름"을 "없음"으로 뭉개지 않는다.** 조회 실패는 보류, 모르는 마감은 지난 것으로 본다.
- **promise를 버리지 않는다**(린트가 막는다). 핸들러에 async 함수를 그대로 넘기지 않고 `() => void fn()`으로 넘기되,
  **실패는 `fn` 안에서 잡아 화면에 말한다** — `void`는 린트만 달랠 뿐 실패를 보여주지 않는다. 버튼이 잠긴 채 멈추거나
  로딩에 영영 머무는 게 이 자리에서 났다.
- **렌더 예외는 가둔다**(`ErrorBoundary`·`guarded`, shared). 화면·카드 단위로 두고, 온체인 회수처럼 **다른 칸이 깨져도
  남아야 하는 칸은 따로** 감싼다. 헤더(🔑 키 보기)는 화면 경계 밖이다.
- 이벤트에는 반드시 `expiration` 태그(보존)를 단다. 예외 3종: `dispute-message`(증거 보존), 운영자 DM gift wrap
  kind 1059, `push-subscription`(계정 단위). **보존과 거래 마감을 섞지 않는다**(DM-009).
- **사람이 알아야 할 일은 운영자 DM으로 보낸다**(`raiseAlert`·`notifyOperators`). 우리 이벤트는 전용 kind라 어떤 nostr
  클라이언트도 울리지 않는다 — 이벤트만 쏘고 운영자가 보겠거니 하면 아무도 모른다(docs/PROTOCOL.md §7).
- Nostr 코드는 각 앱의 `nostr/` 디렉토리에 둔다.
- 테스트는 **프로덕션이 실제로 부르는 경로**를 탄다. 프로덕션이 안 부르는 헬퍼를 검증하면 버그가 초록으로 남는다.
- Dev/Prod 데이터 격리: 태그가 dev(`…-dev`)·prod로 갈린다. dev 전용 코드는 `dev-only/`에 파일 단위로 두고
  `import.meta.env.DEV` 가드 안에서만 import한다.
- 공용 문구·스타일·헬퍼가 두 곳 이상에서 같은 뜻이면 한 곳에 두고 가져다 쓴다. 이미 있는 자리:
  시간 문구·`useNow` = `shared/src/time.ts`·`components/useNow.ts`, 버튼 이름·공통 안내 = `shared/src/copy.ts`,
  유저 앱 훅·스타일 = `customer/src/hooks.ts`·`ui.ts`, 어드민 문구·스타일 = `admin/src/format.ts`·`ui.ts`.
  데몬과 앱이 같은 값을 봐야 하는 규약 상수는 shared 트랙 모듈(`shared/src/ln`·`onchain`)에.

## 레포지토리 구조

```
shared/                 ← @sajwo-tracker/shared — FSM·사유 표·시간·이벤트 코덱·온체인 스크립트/tx·공용 컴포넌트
  src/core.ts           ←   데몬용 입구 (런타임 무관)
  src/ln/  src/onchain/ ←   트랙별 규약 (`/ln`, `/onchain` 입구)
daemon/                 ← 에스크로 에이전트 (Node 24, node:sqlite). src/ln · src/onchain · src/hold(홀드 인보이스 공용)
customer/               ← 통합 유저 앱 (React 19). 패키지 이름은 옛것이다
  src/sponsor/          ←   사주기 탭 (오더북, 첫 화면)
  src/buyer/            ←   의뢰하기 탭
  src/history/          ←   내 거래 탭
  src/ln/               ←   라이트닝 카드 하나(LnOrderCard) — 세 탭·상세 공용. 할 일은 card-view.ts가 데이터로 정한다
  src/onchain/          ←   온체인 트랙 (탭·구독·저장소 분리)
  src/nostr/            ←   통합 구독 (소켓 한 벌) → 역할별 핸들러
  userscript/           ←   쿠팡 자동 파싱 유저스크립트 (esbuild IIFE)
admin/                  ← 어드민 앱 (React 19) — 데몬 리모컨
sponsor/                ← 옛 후원자 도메인 리다이렉트 껍데기
```
