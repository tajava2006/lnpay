# 아키텍처

페어바이는 **운영 PC의 데몬 하나**가 판단·집행을 전부 하고, 나머지는 전부 정적 웹 앱이다. 서로는 nostr 릴레이로만
말한다. 트랙별 규칙은 [LN-TRACK.md](LN-TRACK.md) · [ONCHAIN-TRACK.md](ONCHAIN-TRACK.md), 이벤트 모양은
[PROTOCOL.md](PROTOCOL.md), 위험은 [RISKS.md](RISKS.md), 배포는 [DAEMON-DEPLOY.md](DAEMON-DEPLOY.md).

```
                          nostr 릴레이 (APP kind 10002의 읽기 목록)
        ┌───────────────────────┬──────────────────────┬─────────────────────┐
        │ kind 1111 요청         │ kind 30402 오더        │ kind 1111 명령/결과   │
        │ (유저 → APP)          │ (APP → 모두)          │ kind 30078 상태       │
        │                       │                      │ (운영자 ↔ APP)        │
   유저 앱 (정적 SPA)            │                    어드민 앱 (정적 SPA, 리모컨)
   고객·후원자 한 앱·한 키        │                    운영자 키(NIP-46 번커)로 명령만
   + 쿠팡 유저스크립트            │
                          ┌─────┴──────┐
                          │   데몬      │  운영 PC · docker · 들어오는 포트 없음
                          │  (Node 24)  │── LND REST (홀드 인보이스·지급)
                          │  SQLite     │── mempool.space REST (온체인)
                          │  시드·APP 키 │── 웹 푸시 (FCM·Apple 직접)
                          └────────────┘   시세: 업비트·빗썸·코인원 웹소켓
```

| 부품 | 어디서 | 무엇 |
|---|---|---|
| `daemon/` | 운영 PC 컨테이너(`lnpay-daemon`) | 요청 받기·FSM·LND·체인 감시·서명·발행·푸시 — 돈이 움직이는 모든 것 |
| `admin/` | VPS nginx 정적 서빙, 운영자 폰·PC 브라우저 | 데몬 상태 보기, 명령(판정·강제 종결·설정·채팅). APP 키·LN 자격증명·집행 코드 **없음** |
| `customer/` | VPS nginx 정적 서빙 | 통합 유저 앱. 고객(의뢰하기)·후원자(사주기)·내 거래 탭, 라이트닝·온체인 두 트랙 |
| `customer/userscript/` | 유저 브라우저(Tampermonkey) | 쿠팡 주문 페이지 파싱 → 의뢰 자동 채움, 입금·취소 감지. 유저 앱에서 받을 때 **그 유저의 키가 박혀** 나오고, 결과를 같은 키로 자기 웹앱에 자기암호화해 보낸다(데몬은 안 본다) |
| `sponsor/` | VPS | 옛 후원자 도메인의 리다이렉트 껍데기 |
| `shared/` | 전부 | FSM·규약·이벤트 코덱·시간 값·온체인 스크립트/tx. 데몬은 `@sajwo-tracker/shared/core`·`/ln`·`/onchain`만 가져간다(루트 입구는 React·localStorage를 끌고 온다) |

---

## 1. 데몬

### 불변조건

| ID | 조건 | 막는 것 |
|---|---|---|
| DM-001 | 상태를 바꾸는 코드는 **데몬 프로세스 하나**에서만 돈다. 어드민 앱에는 APP 키·LN 자격증명·집행 코드가 없다 | 다기기 이중 집행(프론트 어드민 시절 이중 에스크로 인보이스) |
| DM-002 | **결정은 트랜잭션 하나다.** 상태 전이와 외부 효과의 *의도*를 같은 트랜잭션에 쓴다 | 상태는 바뀌었는데 할 일이 사라지는 것(크래시) |
| DM-003 | 되돌릴 수 없는 외부 효과가 **확인되기 전에** 그 결과를 전제한 상태를 발행하지 않는다 — settle 성공 전 `paid` 없음, raw tx 기록 전 `settling` 없음 | "발행은 됐는데 돈은 안 움직인" 상태 |
| DM-004 | 받은 이벤트는 **id로 한 번만** 처리한다 | 재구독·중복 전달의 이중 처리 |
| DM-005 | 자금 비밀은 **시드 하나에서 파생**한다 — 프리이미지, 온체인 어드민 키. DB를 잃어도 다시 만든다 | 키·프리이미지 유실 |
| DM-006 | 운영자 명령은 **오더 버전을 확인**한다. 명령이 본 버전과 지금이 다르면 거절 | 낡은 화면에서 누른 판정이 몰수부터 집행하는 것 |
| DM-007 | **들어오는 포트가 없다.** 릴레이·LN·체인·푸시로 나가기만 한다 | 공격면 |
| DM-008 | **시계는 데몬 하나.** 마감은 DB에 있고 재시작하면 따라잡는다 | 탭이 열려 있을 때만 돌던 자동 처리 |
| DM-009 | 이벤트 보존(NIP-40 `expiration`)과 거래 마감을 섞지 않는다 | 거래가 보존 기한을 넘기면 릴레이가 발행을 거절하던 것 |

### 한 바퀴 (틱)

```
수신(ingress) ──→ inbox ──[틱: 15초, 새 이벤트면 1.5초 뒤로 앞당김]──→ 디스패처 → 핸들러
                                                                         │ 트랜잭션 안·네트워크 없이
                                                                         ▼
                          효과 대기열 ◀─ 의도(enqueue) ── 상태 전이
                             │ 트랜잭션 밖·네트워크
                             ▼
                          실행기(LN·브로드캐스트·발행·푸시) → 기록 트랜잭션(onDone: 결과를 전제한 전이)
```

틱 순서(`runtime.ts`): 수수료 갱신 → 받은 요청 처리 → 홀드 인보이스 관찰 → 라이트닝 시계 → 온체인 감시 → 오래
실패한 효과 경보 → 하트비트 → 효과 실행 → 하루 한 번 DB 스냅숏. 틱은 겹치지 않는다.

- **수신**(`nostr/ingress.ts`): APP 앞으로 온 kind 1111을 전부 `inbox`에 넣는다. 구독은 5분마다 새로 연다 — 오래 사는
  구독은 조용히 죽는다. 다시 열 때 커서에서 6시간 되돌아가 받고 겹치는 건 id로 거른다. 첫 부팅 때 `LNPAY_EPOCH`(없으면
  부팅 시각)를 DB에 박고 그 전 이벤트는 안 받는다 — 이 값이 어드민 앱과 유저 앱의 `since`가 된다.
- **디스패처**(`dispatch.ts`): 받은 뒤 1.5초 묵힌 이벤트를 `created_at` 순으로 처리한다(릴레이마다 도착 순서가 다르다).
  핸들러가 던지면 쓰기를 되돌리고 `error`로 닫는다 — 네트워크가 없으니 다시 돌려도 같은 결과다. 받지 않은 요청은
  `ignored:<사유>`로 inbox에 남는다.
- **효과**(`effects.ts`): 의도 → 실행 → 기록. 실행 도중 죽으면 재시작 뒤 다시 돌므로 **전부 멱등**이다(settle 전에 조회,
  같은 서명 이벤트 재발행, 지급 전에 추적). 돈이 걸린 효과는 포기하지 않고 백오프로 계속 다시 한다.
- **홀드 인보이스**(`hold/`): 라이트닝 에스크로·보증금과 온체인 보증금이 **같은 기계**를 쓴다.
  `plan → creating → open → accepted → settled/cancelled`. 트랙은 목적별 `HoldHooks`만 등록한다.
- **발행**: 서명은 의도를 쌓을 때 한 번 한다(재시도가 같은 id를 낸다). 공개 오더는 발행 순간의 DB로 만들고
  `created_at`을 단조 증가시킨다(주소형 이벤트는 같은 초면 id가 작은 쪽이 남는다).

### 저장 (SQLite, `db/migrations.ts`)

| 테이블 | 무엇 |
|---|---|
| `kv` | epoch·커서·설정·수수료 캐시·블록 높이·하트비트 |
| `inbox` | 받은 kind 1111 원문과 처리 결과 (id UNIQUE) |
| `effects` | 효과 대기열 (dedup 키, 시도 횟수, 다음 시각) |
| `alerts` | 운영자 경보 (dedup) |
| `ln_orders` · `ln_drafts` | 라이트닝 오더, 보증금을 기다리는 의뢰 |
| `ln_invoices` | 홀드 인보이스 한 장씩 — 라이트닝·온체인 보증금 공용 |
| `oc_orders` · `oc_candidates` | 온체인 오더, 보증금 결제를 기다리는 의뢰·클레임 후보 |
| `push_subs` · `notices` | 웹 푸시 구독, 보낸 알림 dedup |

`VACUUM INTO`로 하루 한 벌 `backups/`에 스냅숏(최근 7벌). DB를 통째로 잃어도 **돈은 시드로 되찾는다** — 스냅숏이 지키는
건 장부(누가 어느 단계에서 무엇을 결정했는지)다.

### 비밀과 파생

| 비밀 | 파일 | 쓰임 |
|---|---|---|
| 시드 (32바이트) | `LNPAY_SEED_FILE` | 프리이미지 = `HMAC(seed, "lnpay/preimage/v1/<목적>/<오더>[/<사람>]/<시도>")`, 온체인 주문별 어드민 키 = `HMAC(seed, "lnpay/onchain-admin/v1/<오더>/<카운터>")`. 라벨의 `v1`은 약속이다 — 바꾸면 옛 인보이스·주소를 못 되찾는다(`derive.test.ts` 고정 벡터) |
| APP 키 (nsec) | `LNPAY_APP_KEY_FILE` | 오더·통지 서명, 요청 복호화. `LNPAY_APP_PUBKEY`와 다르면 뜨지 않는다 — 유저 앱이 우리 이벤트를 전부 버린다 |
| LND 매크룬·인증서 | `LNPAY_LND_*` | 구운 최소 권한(인보이스·오프체인·정보) |
| VAPID 개인키 | `LNPAY_VAPID_KEY_FILE` | 웹 푸시 서명. 없으면 푸시만 안 간다 |

비밀은 파일로만 받고 로그에 찍지 않는다.

### 모드와 장부

- `LNPAY_MODE=prod|dev` → 태그: prod `sajwo-tracker` / `sajwo-tracker-onchain` / 어드민 태그, dev는 전부 `-dev`.
  유저 앱·어드민 앱은 빌드 모드로 태그가 정해진다 — **데몬 모드와 빌드 모드가 같아야 서로 본다.**
- **장부 하나 = 모드 하나 · 온체인 네트워크 하나**(`guards.ts`). 다른 모드로 띄우거나, 진행 중 온체인 오더가 있는 채로
  네트워크를 바꾸거나 온체인을 끄면 **일부러 뜨지 않는다.** signet 드릴은 별도 장부(`lnpay-data-signet/`)의 별도
  데몬(compose profile `signet`)으로 돌린다.
- 운영 설정(`config.set`, DB): `ln.autoApprove`, `ln.customerDepositPct`, `ln.sponsorDepositPct`(0~20),
  `onchain.acceptNewOrders`. 저장본은 기본값 위에 다시 적용해 읽고, 모르는 키·틀린 타입은 통째로 거부한다.
- 온체인은 `LNPAY_ONCHAIN_NETWORK`가 있을 때만 켜진다(보증금이 LN이라 LND가 있어야 한다).

## 2. 어드민 앱 = 리모컨

운영자 키로 명령을 보내고 데몬이 APP 키로 결과·상태를 돌려준다(`shared/src/admin-protocol.ts`).

| 무엇 | 이벤트 | 방향 |
|---|---|---|
| 명령 | kind 1111 · `action=admin-command` · `p=APP` · 10분 TTL | 운영자 → 데몬 |
| 결과 | kind 1111 · `action=admin-result` · `p=운영자` · `e=명령` | 데몬 → 운영자 |
| 채팅 사본 | kind 1111 · `action=admin-chat` · `p=운영자` | 데몬 → 운영자 |
| 상태 | kind 30078 · `d=lnpay-admin:<태그>:state:<운영자>` | 데몬 → 운영자 (하트비트·설정·경보·epoch·창 길이) |
| 오더 상세 | kind 30078 · `d=lnpay-admin:<태그>:order:<트랙>:<오더>:<운영자>` | 데몬 → 운영자 (인보이스 상태·지급 오류·버전) |

- 전부 NIP-44 암호문, 태그는 어드민 태그. 운영자는 `LNPAY_OPERATORS`에 등록된 키만. **APP 키 로그인은 거부**한다.
- 결과가 안 오면 "응답 없음"으로 끝낸다 — 집행됐는지 모르는 명령을 "실패"로 적으면 재전송이 두 번 집행할 수 있다.
- 오더를 바꾸는 명령은 `{track, orderId, version}`을 싣는다(DM-006).
- 공개 오더 구독은 **데몬 epoch를 알 때만** 연다(`since` = epoch). 옛 프론트 어드민이 같은 키·태그로 낸 오더가 릴레이에
  남아 있다. 처음 뜰 때 옛 어드민의 브라우저 저장소를 한 번 전부 지운다(로그인 세션만 남긴다).
- 분쟁 채팅: 유저는 APP에게 `dispute-message`를 보내고, 데몬이 운영자에게 사본을 중계한다. 운영자 답장(`chat.send`)은
  데몬이 APP 키로 유저에게 보낸다.
- 명령 목록: 공통 `ping`·`config.get/set`·`alert.ack`·`chat.send`, 라이트닝 `ln.approve`·`ln.revert-claim`·`ln.rule`·
  `ln.force-close`·`ln.retry-payout`·`ln.reveal-request`·`ln.detail`, 온체인 `oc.rule`·`oc.account-dispute`·`oc.resend`·
  `oc.rescue`·`oc.detail`.
- URL이 화면 상태다(`admin/src/routing.ts`) — 새로고침해도 같은 오더가 열린다.

## 3. 유저 앱

### 헌법 — 저장소 구독 패턴

```
Nostr 릴레이 → Nostr 서비스(백그라운드) → 영구 저장소 → UI
```

1. UI는 릴레이를 **직접 참조하지 않는다.** 저장소(localStorage·IndexedDB)만 `useSyncExternalStore`로 구독한다.
2. 서비스가 백그라운드에서 구독·발행하고 결과를 저장소에 쓴다.
3. 서비스와 UI의 생명주기는 독립이다.

통합 앱은 `customer/src/nostr/`가 소켓을 단독 소유하고 역할별 핸들러(`buyer/nostr`, `sponsor/nostr`, `onchain/nostr`)로
팬아웃한다. 역할 모듈은 구독을 직접 만들지 않는다.

### 역할과 탭

- **한 앱·한 키**(2026-09-12 통합). 역할은 오더의 `customerPubkey`·`sponsorPubkey`와 내 pubkey를 비교해 유도한다 — 저장된
  역할 칼럼이 없다. 한 오더에서 둘 다 참일 수 있는 건 자기 클레임뿐인데 데몬이 막는다.
- 탭: 사주기(첫 화면, 오더북) · 의뢰하기 · 내 거래. 라이트닝 의뢰는 어느 탭에서든 **같은 카드**(`customer/src/ln/`)로
  그리고, 할 일은 탭이 아니라 데이터로 정한다(`card-view.ts`).
- 온체인은 `customer/src/onchain/`에 따로 있다(탭·구독·저장소 분리). 화면 문구는 "나 / 상대방"이다.

### 키

- 유저 nostr 키는 첫 방문 때 브라우저에서 만들어 localStorage에 둔다. 오리진이 바뀌면 다른 사람이 된다.
- 온체인 주문별 키는 그 키에서 HMAC으로 파생한다(추가 백업 없음). ⚠️ 지금 백업·내보내기 화면이 없다 — RISKS R-1.

### 기타

- `since`: 빌드 때 `VITE_NOSTR_SINCE`(레포 루트 `.env`, vite `envDir: '..'`)가 들어가면 그 뒤의 이벤트만 구독한다. 데몬
  epoch 이상으로 둔다.
- 공사 중 스위치: `customer/src/main.tsx`의 `MAINTENANCE` 상수(코드). `true`인 prod 빌드엔 앱 코드가 아예 안 들어간다.
  `pnpm preview:customer`(`--mode localopen`)는 로컬에서만 연다.
- 온체인 체인 조회는 유저 앱도 공개 mempool.space로 직접 한다(주소 검증·타임락 잔여·CPFP). 탐색기 링크는 주소가 그
  네트워크 것일 때만 만든다.

## 4. 알림

- **웹 푸시** — 데몬이 RFC 8291로 암호화해 푸시 서비스(FCM·Apple)에 **직접** 보낸다(서버라 CORS 중계가 필요 없다).
  구독은 유저가 `push-subscription`(암호문, 만료 없음 — 계정 단위)으로 등록한다. 실패해도 거래를 막지 않고 3번까지만
  다시 한다. 404·410이면 그 구독을 끈다.
- VAPID 공개키는 `shared/src/constants.ts`의 `VAPID_PUBLIC_KEY`. 바꾸면 기존 구독이 전부 죽는다.
- 알림은 "내 차례"일 때 간다. 푸시 URL에 `order=`가 붙어 누르면 그 거래가 열린다.
- 유저용 NIP-17 DM 알림은 꺼져 있다(`NOSTR_DM_NOTIFICATIONS = false`) — 웹 푸시가 주요 브라우저를 다 덮는다.
- **운영자 경보**는 NIP-17 DM으로 간다(`daemon/src/admin/notify.ts`, 데몬 릴레이로만). 같은 사유로는 한 번만 울린다.
  데몬이 죽으면 이것도 못 간다 — RISKS R-3.

## 5. 릴레이

- APP의 **kind 10002 읽기 목록**이 만남의 장소다. 유저 앱은 디스커버리 릴레이에서 그걸 찾고(10분마다 갱신, 실패하면 폴백),
  데몬은 `LNPAY_RELAYS`로 고정하지 않았으면 같은 목록을 쓴다 — 다르면 서로 못 만난다.
- 한 릴레이라도 받으면 발행 성공이다(RISKS R-14).
- 서명 검증은 nostr-tools가 한다. 발신자 확인(누가 보냈나)은 앱·데몬이 따로 한다(I-008·O-020).

## 6. 빌드·테스트

- pnpm 워크스페이스. `pnpm verify:web` = 타입체크 + 테스트(데몬 제외, VPS용). 데몬은 `pnpm build:daemon`(esbuild 번들
  `daemon/dist/daemon.mjs`, docker가 빌드).
- 테스트는 vitest — `shared`·`admin`·`customer`·`daemon` 각자. 데몬 테스트는 가짜 릴레이·가짜 LND·가짜 체인으로 크래시
  재시작까지 돈다. CI는 master push와 PR에서 돈다(`.github/workflows/ci.yml`, 데몬 포함 `pnpm verify` + 전 앱 빌드).
- 의존성은 latest를 따라간다(`./update-deps.sh`). 예외: 온체인 서명 경로의 `@noble/curves`는 `@scure/btc-signer`가 쓰는
  버전에 **정확히 핀**한다(한 인스턴스). 갈리면 `onchain-tx.test.ts`가 잡는다.
- 배포: 유저·어드민 앱은 VPS에서 `pnpm ship`(pull → 검증 → 빌드). 데몬은 운영 PC에서 `docker compose build lnpay-daemon`
  — **코드를 바꾸면 이미지를 다시 빌드해야 한다**(옛 이미지로 돌면 마감·문구가 어긋난다).
