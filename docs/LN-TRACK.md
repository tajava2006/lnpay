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
| `requested → claimed` | 후원자 `claim` | 자기 의뢰가 아님, 기한까지 1시간 이상 |
| `claimed → requested` | 워처 / 운영자 `ln.revert-claim` | 후원자 보증금을 15분 안에 안 냄, 보증금 인보이스를 노드가 못 만듦 |
| `claimed → verified` | 자동 승인(설정) 또는 운영자 `ln.approve` | 후원자 보증금 받음(켜져 있으면), 시세 있음, 에스크로 결제창 ≥ 10분. **에스크로 인보이스가 노드에 생긴 뒤** 전이 |
| `verified → escrowed` | 고객이 에스크로 결제 (HTLC accepted) | |
| `escrowed → invoiced` | 후원자 `sponsor-invoice` | 금액 **정확 일치**(I-011), 수명 ≥ 6시간, 에스크로 HTLC 잔여 ≥ 108블록, 우리 인보이스가 아님 |
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
| `MIN_SPONSOR_INVOICE_LIFETIME_SEC` | 6시간 | 후원자 인보이스 최소 잔여 수명(지급 직전 재제출은 10분) |
| `CLTV_MAX_BLOCKS` / `CLTV_MIN_BLOCKS` | 1500 / 40 | 우리가 요구하는 최종 CLTV의 상·하한 |
| `BLOCK_SEC` | 600 | 초 → 블록 환산. **블록이 빨리 나오면 실제 시간이 짧아진다** |
| `INVOICE_ESCROW_MIN_BLOCKS` | 108 | 후원자 인보이스를 받으려면 에스크로가 이만큼 더 살아야 한다 |
| `ESCROW_END_BLOCKS` | 72 | `escrowed`·`invoiced`인데 에스크로가 이만큼 안 남으면 기한 만료 사유로 닫는다 |
| `SAFETY_SETTLE_BLOCKS` | 36 | `remitted`인데 이만큼 안 남으면 **먼저 settle**한다(비대칭 손실 원칙) |
| `REMITTED_ALERT_SEC` | 12시간 | `remitted`가 확인 없이 이만큼 머물면 운영자를 부른다 |
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
- 인보이스가 만료됐으면 후원자에게 재제출을 요청하고 멈춘다(`EXPIRED_BEFORE_PAYOUT`). 재제출이 지급을 다시 쌓는다.
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
