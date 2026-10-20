# 라이트닝 트랙 — 상태 머신 · 규약 · 시간

쿠팡 대리결제다. 고객은 BTC를 홀드 인보이스로 에스크로에 걸고, 후원자는 쿠팡 가상계좌에 원화를 넣은 뒤
라이트닝으로 BTC를 받는다. 판단과 집행은 전부 **데몬**이 하고(→ [ARCHITECTURE.md](ARCHITECTURE.md)), 운영자는
분쟁 판정·강제 종결 같은 사람 몫만 어드민 앱으로 명령한다.

**이 문서의 진실은 코드다.** 표는 아래 파일을 옮긴 것이고, 부등식은 `daemon/src/__tests__/timing-invariants.test.ts`가
빌드마다 확인한다. 둘이 어긋나면 코드가 맞고 이 문서를 고친다.

| 무엇 | 파일 |
|---|---|
| 전이 표 | `shared/src/ln/state-machine.ts` |
| 닫기 사유 → 돈 처리 | `shared/src/ln/outcomes.ts` (`CLOSE_RULES`) |
| 시간 값 | `daemon/src/ln/timing.ts`, `shared/src/ln/order.ts` |
| 요청 처리 | `daemon/src/ln/handlers.ts` |
| 지정 거래 규약(스냅샷·확인 코드) | `shared/src/designated.ts` |
| 시계(기한·만기·자동 승인) | `daemon/src/ln/watcher.ts` |
| 돈이 움직이는 순서 | `daemon/src/ln/flow.ts`, `daemon/src/ln/effects.ts`, `daemon/src/hold/` |

---

## 1. 돈의 흐름

| 인보이스 | 누가 낸다 | 받는 쪽 | 끝 |
|---|---|---|---|
| 고객 보증금 (홀드) | 고객 | 데몬 노드 | 닫기 사유대로 settle(몰수) / cancel(환불) |
| 후원자 보증금 (홀드) | 후원자 | 데몬 노드 | 닫기 사유대로 |
| **에스크로** (홀드) | 고객 | 데몬 노드 | 정상·후원자 승 → settle, 그 밖 → cancel |
| 지급 | 데몬 노드 | 후원자 인보이스 | settle 성공 뒤에만 |

- 금액은 **승인 순간** 한 번 정한다. `payoutSat = 가격 ÷ 시세`, 에스크로 = `⌈payoutSat × 1.005⌉`.
  에스크로가 payout에서 파생되므로(반대가 아니다) 후원자 인보이스 검증이 등식이 된다.
- 보증금 비율은 운영 설정이다(`ln.customerDepositPct`·`ln.sponsorDepositPct`, 기본 0 = 끔, 상한 20).
  금액은 요청 시점 시세로 `가격 × 비율`. 0이면 그 보증금 단계가 통째로 빠진다.
- 홀드 인보이스 cancel은 HTLC 실패라 **라우팅 수수료가 0**이다. 환불이 공짜인 이유다.
- 프리이미지는 저장하지 않는다. `(목적, 오더, 사람, 시도)`에서 시드로 다시 만든다(DM-005).

## 2. 상태 머신

```
requested ⇄ claimed → verified → escrowed → invoiced ─→ remitted ─→ paid
                                                 │                ├──→ sponsor_wins
                                                 └──→ paid        └──→ customer_wins

cancelled     ← requested · claimed · verified
expired       ← requested · claimed · verified · escrowed · invoiced   (쿠팡 기한)
admin_closed  ← escrowed · invoiced                                    (운영자)
```

터미널은 전이 맵에서 유도한다(`LN_TERMINAL_STATES`) — 손으로 나열한 목록은 반드시 갈라진다.

### 전이와 방아쇠

| 전이 | 방아쇠 | 조건 |
|---|---|---|
| (없음) → `requested` | 고객 `order-request` | 기한이 1시간 ~ 7일 뒤. 보증금이 켜져 있으면 **보증금이 잡힌 뒤에** 오더가 생긴다(그 전엔 초안) |
| (없음) → `requested` | 고객 `designated-order-request` (§7) | 같은 기한 조건, 자기 지정 아님. **보증금 없이 바로** 오더 |
| `requested → claimed` | 후원자 `claim` | 자기 의뢰가 아님, 기한까지 1시간 이상. 지정 거래면 지정 후원자만 |
| `claimed → requested` | 워처 / 운영자 `ln.revert-claim` | 후원자 보증금을 15분 안에 안 냄, 보증금 인보이스를 노드가 못 만듦 |
| `claimed → verified` | 자동 승인(설정 — 지정 거래는 설정과 무관하게) 또는 운영자 `ln.approve` | 후원자 보증금 받음(켜져 있고 공개 거래면), 시세 있음, 에스크로 결제창 ≥ 10분. **에스크로 인보이스가 노드에 생긴 뒤** 전이 |
| `verified → escrowed` | 고객이 에스크로 결제 (HTLC accepted) | |
| `escrowed → invoiced` | 후원자 `sponsor-invoice` | 금액 **정확 일치**(I-011), 수명 ≥ 10분, 에스크로 HTLC 잔여 ≥ 108블록, 우리 인보이스가 아님 |
| `invoiced → remitted` | 후원자 `remit-request` | 요청 시각 ≤ 기한 + 1시간 |
| `invoiced·remitted → paid` | 고객 `payment-confirm` | 에스크로 **settle 성공 뒤에** `paid` 발행(DM-003) → 지급 |
| `remitted → sponsor_wins·customer_wins` | 운영자 `ln.rule` | |
| `escrowed·invoiced → admin_closed` | 운영자 `ln.force-close` | 기한 전에 끊어야 할 때만 — 기한 만료가 자동으로 닫는다 |
| `→ cancelled` | 고객 `cancel-request` / 워처 | `requested·claimed·verified`에서만. 에스크로 미납은 워처가 |
| `→ expired` | 워처 | 쿠팡 기한(에스크로 뒤는 + 1시간 유예)이 지남. 사유는 §3 |

### 열지 않는 전이 — 이유가 있다

- **`escrowed·invoiced → cancelled` 없음.** 고객이 코드를 고쳐 계좌를 미리 뿌리고 후원자가 송금한 직전에
  취소하면 원화가 공중에 뜬다(T-003). 멈춘 거래는 기한 만료와 운영자 강제 종결이 끝낸다.
- **`escrowed → paid` 없음.** `escrowed`는 지급 대상(후원자 인보이스)이 아직 없는 상태다. 거기서 settle하면
  BTC를 받아 놓고 보낼 곳이 없다(I-010). 지름길은 `invoiced → paid`다.
- **`remitted`에는 기한 만료가 없다.** 원화가 갔다는 주장이 있으면 사람이 판정한다.
- **`admin_closed`를 `cancelled`와 가른다.** 사람이 끊은 것과 고객이 접은 것은 보증금 처리가 다르다.

## 3. 닫기 사유 → 돈 처리

**사유가 곧 처리다.** 전이만 보면 반대로 처리한다 — `cancelled` 하나에 고객 보증금을 돌려주는 경우와 가져가는
경우가 섞여 있다. `CLOSE_RULES`는 `Record`라 사유를 추가하면 빌드가 깨진다.

| 사유 | 종결 | 에스크로 | 고객 보증금 | 후원자 보증금 |
|---|---|---|---|---|
| `paid` | paid | settle | 환불 | 환불 |
| `sponsor_wins` | sponsor_wins | settle | 환불 | 환불 |
| `customer_wins` | customer_wins | cancel | 환불 | **몰수** |
| `admin_closed` | admin_closed | cancel | 환불 | 환불 |
| `cancel:customer` (후원자 없음) | cancelled | cancel | 환불 | 환불 |
| `cancel:customer-after-claim` | cancelled | cancel | **몰수** | 환불 |
| `cancel:unpaid-escrow` | cancelled | cancel | **몰수** | 환불 |
| `expired:no-sponsor` | expired | cancel | 환불 | 환불 |
| `expired:not-approved` | expired | cancel | 환불 | 환불 |
| `expired:unpaid-escrow` | expired | cancel | **몰수** | 환불 |
| `expired:no-invoice` (에스크로 뒤 인보이스 없음) | expired | cancel | 환불 | **몰수** |
| `expired:no-account` (인보이스 뒤 계좌 없음) | expired | cancel | **몰수** | 환불 |
| `expired:no-remit` (계좌 뒤 송금 완료 없음) | expired | cancel | 환불 | 환불 |

- **기한 만료 사유는 상태와 계좌 전달 여부로 정한다**(`expiryReasonFor`). `invoiced`에서 계좌가 안 나갔으면 고객 탓,
  나갔으면 원화가 오갔을 수 있어 누구 탓인지 모른다 — 몰수가 피해자를 칠 수 있으니 전부 돌려준다.
- **고객 보증금은 거래가 닫힐 때까지 산다.** 에스크로가 잡혀도 돌려주지 않는다 — 에스크로 뒤에도 고객이 할 일
  (계좌 전달)이 남고, 안 하면 `expired:no-account`로 몰수한다.
- 클레임했다 풀린 옛 후원자의 보증금은 언제나 환불이다(잘못이 가려진 적 없다).
- 닫기는 효과 하나(`ln.close`)가 인보이스마다 **조회부터** 해서 정리하고, 그 결과를 적은 뒤에 종결 상태를 낸다.
  지급 사유인데 에스크로를 받을 수 없으면(HTLC가 이미 취소됨) 닫기를 포기하고 경보를 올린다 — 받지 않은 돈을
  지급하는 경로는 없다.
- 선제 settle(§5) 뒤에 `customer_wins`가 나면 에스크로 BTC는 이미 우리에게 있다. 자동 환불이 안 되므로
  경보가 뜨고 운영자가 손으로 돌려준다.

## 4. 불변조건

| ID | 조건 | 막는 것 |
|---|---|---|
| I-001 | 프리이미지는 저장하지 않고 시드에서 파생한다 | DB 유실 = 에스크로 유실 |
| I-002 | 에스크로 settle은 `paid`·`sponsor_wins`·선제 settle(§5)에서만 | 정당한 사유 없이 고객 BTC를 가져가는 것 |
| I-003 | 보증금·에스크로 처리는 닫기 사유(`CLOSE_RULES`)만 정한다 | 사람이 안 보면 몰수할 이탈이 공짜가 되던 것 |
| I-004 | settle 성공 전에 `paid`를 발행하지 않는다(DM-003) | `paid` 뒤 settle 실패로 후원자만 잃는 것 |
| I-005 | 에스크로 뒤로 고객 일방 취소가 없다 | 선취적 취소(T-003) |
| I-006 | 기한 만료로 닫는 건 `remitted` 전까지 | 원화를 보냈다는 주장을 시계가 뭉개는 것 |
| I-007 | 자기 의뢰를 자기가 클레임할 수 없다 | 역할 유도(내역 화면)가 깨지는 것 |
| I-008 | 모든 요청은 보낸 사람을 본다(고객 요청은 그 오더의 고객, 후원자 요청은 그 오더의 후원자) | 남의 오더에 지급처를 꽂거나 남 대신 입금 확인을 누르는 것 |
| I-009 | 계좌 정보는 `invoiced` 이전에 나가지 않는다 | 후원자가 받을 준비도 안 된 채 원화부터 보내는 것 |
| I-010 | 지급 대상 인보이스 없이 에스크로를 settle하지 않는다 | BTC를 받아 놓고 보낼 곳이 없는 것 |
| I-011 | 후원자 인보이스 금액은 `payoutSat`과 **정확히** 같아야 한다 | 금액을 정한 게 우리인데 근사로 받아주는 것 |

I-009는 유저 앱이 발행 직전에 한 번 더 본다(`canSendAccountInfo`). 데몬도 그 전의 `account-info`를 무시한다.

## 5. 시간

기준은 **쿠팡 가상계좌 기한(`deadline`)** 하나다. 그 뒤로는 원화가 갈 수 없고, 나머지 창은 전부 그 안에서
거래가 끝나게 잡는다. 오더 이벤트의 `expiration`은 **릴레이 보존**이지 거래 마감이 아니다(DM-009).

```
의뢰 ─(고객 보증금 ≤1h)─ 오더 ─ 클레임 ─(후원자 보증금 15m)─ 승인 ─(에스크로 결제 ≤24h, 기한 30분 전까지)─ escrowed
     escrowed ─(인보이스 마감 6h, 기한 + 1h를 넘지 않게)─ 못 내면 expired:no-invoice
     … invoiced … remitted ─────────────────────────── 기한 ─(유예 1h)─ 기한 만료로 닫힘(remitted 제외)
에스크로 HTLC:   승인 ────────────────────── max(결제 기한, 기한 + 1h) + 48h
보증금 HTLC:     요청·클레임 ─────────────── 기한 + 1h + 48h + 24h
```

### 값

| 이름 | 값 | 뜻 |
|---|---|---|
| `LN_MAX_DEADLINE_LEAD_SEC` | 7일 | 받는 기한의 상한. 보증금 CLTV가 이걸로 묶인다 |
| `LN_MIN_CLAIM_LEAD_SEC` | 1시간 | 기한까지 이보다 짧으면 클레임을 안 받는다(오더북도 숨긴다) |
| `CUSTOMER_DEPOSIT_PAY_SEC` | 1시간 | 고객 보증금 결제 창(기한 1시간 전까지로 잘림) |
| `SPONSOR_DEPOSIT_PAY_SEC` | 15분 | 후원자 보증금 결제 창. 못 내면 클레임이 풀린다 |
| `ESCROW_PAY_WINDOW_SEC` | 24시간 | 에스크로 결제 창의 상한 |
| `ESCROW_PAY_LEAD_SEC` | 30분 | 에스크로 결제는 기한 이만큼 전에 끝나야 한다 |
| `MIN_ESCROW_PAY_WINDOW_SEC` | 10분 | 결제 창이 이보다 짧으면 승인하지 않는다 |
| `DEADLINE_GRACE_SEC` | 1시간 | 기한 뒤 유예 — `escrowed`·`invoiced`에만. 이 안의 송금 완료·입금 확인은 받는다 |
| `ESCROW_HOLD_MARGIN_SEC` | 48시간 | 에스크로 HTLC가 기한 + 유예 뒤로 더 사는 시간(송금 완료·확인·분쟁) |
| `SPONSOR_DEPOSIT_MARGIN_SEC` | 73시간 | 보증금 HTLC가 기한 뒤로 사는 시간 = 유예 + 48h + 24h |
| `CUSTOMER_DEPOSIT_MARGIN_SEC` | 73시간 | 위와 같다 — 고객 보증금도 닫을 때까지 산다 |
| `MIN_SPONSOR_INVOICE_LIFETIME_SEC` | 10분 | 후원자 인보이스 최소 잔여 수명 — 등록·재제출 공통. 예전 6시간은 1시간짜리 지갑 기본 인보이스(BOLT11 기본값)를 전부 막았다(2026-10-20). 지급 때 만료돼 있으면 재제출로 푼다(§6) |
| `CLTV_MAX_BLOCKS` / `CLTV_MIN_BLOCKS` | 1500 / 40 | 우리가 요구하는 최종 CLTV의 상·하한 |
| `BLOCK_SEC` | 600 | 초 → 블록 환산. **블록이 빨리 나오면 실제 시간이 짧아진다** |
| `INVOICE_ESCROW_MIN_BLOCKS` | 108 | 후원자 인보이스를 받으려면 에스크로가 이만큼 더 살아야 한다 |
| `ESCROW_END_BLOCKS` | 72 | `escrowed`·`invoiced`인데 에스크로가 이만큼 안 남으면 기한 만료 사유로 닫는다 |
| `SAFETY_SETTLE_BLOCKS` | 36 | `remitted`인데 이만큼 안 남으면 **먼저 settle**한다(비대칭 손실 원칙) |
| `REMITTED_ALERT_SEC` | 12시간 | `remitted`가 확인 없이 이만큼 머물면 운영자를 부른다 |
| `PAYOUT_INVOICE_WAIT_ALERT_SEC` | 6시간 | 지급 때 후원자 인보이스가 만료돼 멈춘 뒤 새 인보이스가 이만큼 없으면 운영자를 부른다(후원자는 만료 순간 푸시를 받았다) |
| `INVOICE_WINDOW_SEC` | 6시간 | 에스크로 뒤 후원자 인보이스 등록 마감. 마감 = min(에스크로 + 6h, 기한 + 유예) — 데몬이 `escrowed` 때 오더에 찍는다(`invoice-deadline` 태그). "에스크로"는 **데몬이 본 시각**이다(데몬이 꺼져 있던 동안은 후원자가 차례를 몰랐다). 넘기면 `expired:no-invoice`(부등식 ④-3) — 핸들러도 마감 뒤(요청 시각 기준) 첫 인보이스를 받지 않는다(워처가 닫기 전 틈). 예전엔 기한 + 유예까지라 트롤이 고객 BTC를 최대 7일 묶었다(RISKS R-5) |
| `LND_DOWN_ALERT_SEC` | 10분 | LND가 이만큼 응답하지 않으면 운영자를 부른다 — 선제 settle 창(노드 자동 취소 전 ~4시간)의 4분의 1 안(부등식 ④-2) |
| `PAY_BY_SKEW_SEC` | 60초 | 결제 기한 판정 여유(노드·데몬 시계 차) |
| `CATCHUP_WARMUP_SEC` | 2분 | 재시작 직후엔 기한 만료로 닫지 않는다 — 꺼져 있던 동안 쌓인 요청을 먼저 받는다 |
| `LN_ACTIVE_RETENTION_SEC` | 30일 | 진행 중 오더 이벤트 보존 = max(기한, 지금) + 30일 |
| `LN_TERMINAL_RETENTION_SEC` | 7일 | 종결 오더 이벤트 보존 |
| `LN_REQUEST_RETENTION_SEC` | 7일 | 요청 이벤트 보존 |

### 지켜야 할 부등식

전부 `timing-invariants.test.ts`가 확인한다. 하나라도 깨지면 아래 결과가 난다.

```
① 기한 상한 + 보증금 여유 (7d + 73h = 1446블록)  ≤  CLTV_MAX (1500)
   └ 깨지면: cltvBlocksFor가 조용히 1500으로 잘라 보증금이 판정 전에 만료된다 — 몰수가 사라진다
② 기한 상한 + 유예 + 48h (7d + 49h = 1302블록)    ≤  CLTV_MAX
③ 보증금 여유 (73h)  >  에스크로 여유 (1h + 48h)
   └ 깨지면: 에스크로가 끝난 뒤의 판정에서 후원자 보증금이 이미 없다(차이 24h = 144블록)
④ INVOICE_ESCROW_MIN (108) > ESCROW_END (72) > SAFETY_SETTLE (36) > LND holdexpirydelta (12)
   └ 인보이스를 받을 때 → 닫을 때 → 선제 settle → 노드가 스스로 취소할 때 순서가 뒤집히면 안 된다
⑤ 클레임 최소 잔여 (1h)  ≥  후원자 보증금 창 (15m) + 에스크로 lead (30m) + 최소 결제 창 (10m)
   └ 깨지면: 막바지 클레임이 승인될 수 없어 후원자 보증금만 묶였다 풀린다
⑥ 진행 중 오더 보존 (기한 + 30d)  >  에스크로 HTLC 수명 (기한 + 49h)
   └ 깨지면: 거래 도중 릴레이가 오더 발행을 거절한다(NIP-40)
⑦ 재시작 워밍업 (2m)  <  기한 유예 (1h)
```

⚠️ **블록 시간 가정.** 모든 CLTV는 블록 = 600초로 환산한다. 블록이 평균보다 빨리 나오면 HTLC가 벽시계로 더
일찍 죽는다. 그래서 에스크로는 시간이 아니라 **블록 높이**로 지킨다(④의 세 문턱, `htlc_expiry_height` 기준).
보증금에는 그런 안전망이 없다 — ③의 24시간이 완충이다.

## 6. 지급 · 프로빙 · 분쟁

**지급**(`ln.payout`)은 `paid`·`sponsor_wins`에서 settle 성공 뒤에 한 번 쌓인다.
- 먼저 결제를 **추적**한다(이미 나갔으면 끝, 진행 중이면 30초 뒤). 두 번 지급은 LND도 막는다.
- 실패는 백오프로 계속 다시 하고, 오래 실패하면 운영자 경보. 운영자가 `ln.retry-payout`으로 앞당길 수 있다.
- 인보이스가 만료됐으면 후원자에게 재제출을 요청하고 멈춘다(`EXPIRED_BEFORE_PAYOUT` 통지 + **웹 푸시**, `payout_error` =
  `LN_PAYOUT_INVOICE_EXPIRED`). 재제출이 지급을 다시 쌓는다. 등록 하한이 10분이라 흔한 경로다 — BTC는 데몬에 있고 후원자가
  한 번 더 내는 불편뿐이다. 통지는 종결 오더처럼 7일 산다(유저 앱은 통지가 있어야 재등록 칸을 연다).
  `PAYOUT_INVOICE_WAIT_ALERT_SEC` 넘게 새 인보이스가 없으면 운영자 경보.
- **지급이 시작된 뒤 인보이스 교체는 만료가 확인된 뒤에만**(`payout_error` = `LN_PAYOUT_INVOICE_EXPIRED`) — 그 전에 온 건
  `ignored:payout-in-progress`. 노드 멱등성은 결제 해시 하나까지라, 진행 중에 바꾸면 옛 HTLC와 새 것이 둘 다 나갈 수 있다(RISKS T-014).
- **경로가 오래 없는데 만료는 한참 남았으면 운영자가 직접 처리한다** — `ln.manual-payout`(자동 지급 멈춤) → 지급기가 지금 인보이스를
  추적해 성공도 진행 중도 아님을 본 뒤 `manual`(진행 중이면 기다리고, 그 사이 나가면 그냥 완료) → 그때부터 데몬은 이 거래에 결제하지
  않는다(재시도·재제출 모두 막힘) → 운영자가 CS로 받은 인보이스를 노드에서 직접 결제 → `ln.mark-disbursed`(기록만).
  성공이 멈춤에 지워지지 않는 이유: 지급기는 **추적을 먼저** 하고 멈춤 표시를 그 뒤에 본다(노드 성공이 기록보다 먼저여도 완료가 된다).
  멈춤·만료 판정은 방금 추적한 그 인보이스가 여전히 지급처일 때만 적는다. 전제: **LND ≥ v0.18.0** — 걸린 HTLC가 하나라도 있으면
  상태가 IN_FLIGHT라, FAILED면 나중에 성공할 HTLC가 없다(`lnd/payments/db/payment_status.go` `decidePaymentStatus`).
  ⚠️ `manual`이 되기 전에 직접 결제하면 두 번 나갈 수 있다. 교체 예약(데몬이 알아서 갈아끼우기)은 크기·버그 위험 대비 드물어서 안 만들었다(2026-10-21).
- 다시 하지 않는 실패(지급처 없음·금액 불일치 — 불변조건 위반)는 **바로** 운영자 경보 — 효과 막힘 경보는 대기 중인 효과만 본다.
- 어드민 상세의 "지급" 줄은 아직 아님 · 보내는 중 · 멈춤(만료) · 실패(사유) · 완료 · 없음을 가른다(`admin/src/format.ts` `lnPayoutText`).
- 수수료 상한은 `max(10 sats, payout의 1%)`다.

**유동성 프로빙**은 후원자 인보이스를 받을 때 한 번, 무작위 해시로 한다. **막지 않고 알려만 준다**
(`LIQUIDITY_WARNING`) — 프로빙은 소액에서 거짓 음성이 나고, 모자라서 잃는 건 후원자 자신이다. 자리는 원화 송금이라는
되돌릴 수 없는 행동 **바로 앞**이다.

**분쟁**(`remitted`)은 사람이 판정한다(`ln.rule`).
- 증거는 오더별 암호화 채팅으로 모은다. 데몬이 중계하고, 어드민 앱은 채팅을 운영자 키로 주고받는다.
- 계좌 증명: 고객은 `account-info`의 공개 태그에 **솔트를 넣은 커밋먼트**를 남긴다. 운영자가 `ln.reveal-request`를
  보내면 후원자 앱에 "받은 계좌 공개" 버튼이 열리고, 공개된 계좌 + 솔트를 커밋먼트와 대조한다. 요청 없이 열어 두면
  분쟁도 아닌데 계좌가 운영자에게 흘러간다.
- 판정이 늦으면 선제 settle(§5)이 먼저 BTC를 받아 둔다 — settle된 에스크로는 어느 쪽으로든 판정할 수 있지만
  (후원자 승 → 지급, 고객 승 → 수동 환불), HTLC가 만료되면 되돌릴 수 없다.

## 7. 지정 거래 — 보증금 없는 1:1

**상대(후원자)를 pubkey로 묶은 의뢰**다. 신원 없는 공개 오더북에서 트롤을 막는 건 보증금뿐인데, 보증금(홀드 인보이스)은
지갑을 가린다. 다른 곳에서 이미 합의한 두 사람은 그게 필요 없다 — 상대를 묶으면 트롤은 손을 댈 수 없고, 남는 위험은
"내가 고른 상대가 째는 것" 하나다(RISKS R-16).

- 후원자가 자기 주소(npub)를 카톡 등으로 고객에게 준다 → 고객이 의뢰 폼 "지정 거래"에 붙여넣고 **확인 코드**(npub 앞 6 ·
  뒤 6)를 상대 화면과 대조 ☑ + 위험 고지 ☑ → `designated-order-request`. 조건·상대는 APP에게 암호문이다.
- 데몬은 **초안·고객 보증금 없이** 바로 오더를 만들고(`designated_sponsor` 칼럼), 공개 오더 대신 고객 · 지정 후원자 · 운영자에게
  암호문 스냅샷(33839)을 낸다 — 오더북에는 안 뜬다(PROTOCOL §2). 지정 후원자에게 웹 푸시 "지정한 거래가 도착".
- 후원자 앱 사주기 탭 "나를 지정한 거래" → 이야기한 금액·기한인지 보고 고지 ☑ → [수락] = 보통 `claim`. 후원자는
  확인 코드를 대조하지 않는다 — 누군가 내 주소를 지정해야만 뜨고 끼어들 자리가 없다(잘못 붙여넣기는 고객 쪽 대조가 막는다). 데몬은 지정 pubkey가
  아니면 무시하고(`not-designated`), 맞으면 **후원자 보증금 없이** 자동 승인 설정과 무관하게 승인한다.
- 그 뒤는 공개 거래와 같다(에스크로 → 인보이스 마감 6h → 계좌 → 송금 → 확인 · 분쟁). 닫기 사유·돈 처리도 같고, 보증금
  칸은 "없음"으로 흘러간다.
- 보증금 필요 여부는 `flow.ts` `sponsorDepositRequired` 한 곳이 정한다(클레임·워처·승인·발행이 같이 쓴다).
- 지정 상대는 **곡선 위의 pubkey**여야 한다(`isPubkeyHex`) — 64자 hex만 보면 txid 같은 값이 통과해 스냅샷을 봉하지 못한다.
  발행기(`daemon/src/orders/publish.ts`)도 봉하지 못하는 수신자는 빼고 나머지에게 내고 경보를 올린다(무한 재시도 없음).
- **스팸 억제**(RISKS R-16 ⑥): 고객 키 하나당 수락 대기 지정 의뢰 `MAX_OPEN_DESIGNATED_PER_CUSTOMER`개(넘으면
  `ignored:too-many-designated` — 라이트닝은 거절 통지가 없어 폼이 미리 막는다), 도착 푸시(대상마다)·운영자 DM은 10분에 한 번.
- 운영자를 더하면 부팅 때 지정 거래 스냅샷을 다시 낸다(스냅샷은 발행할 때의 운영자에게만 간다).
- 거절 버튼은 없다 — 말로 알리고 고객이 취소하거나 기한으로 닫힌다.
