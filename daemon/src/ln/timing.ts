/**
 * 라이트닝 트랙의 시간 값 (PLAN-DAEMON §7)
 *
 * 기준은 **쿠팡 가상계좌 기한(`deadline`)** 하나다 — 그 뒤로는 원화가 갈 수 없다. 나머지 창은 전부
 * 그 기한 안에서 거래가 끝날 수 있게 잡는다.
 *
 * ```
 * 클레임 ─(보증금 15분)─ 승인 ─(에스크로 결제 ≤24h, 기한 30분 전까지)─ escrowed ─ … ─ 기한 ─(유예 1h)─ 종결
 *                                                  └ 에스크로 HTLC는 max(결제창, 기한 + 유예) + 48h (분쟁 여유)
 * ```
 */
import { LN_MAX_DEADLINE_LEAD_SEC, LN_MIN_CLAIM_LEAD_SEC } from '@sajwo-tracker/shared/ln';

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 블록 하나를 몇 초로 보나 — CLTV 블록 수를 셀 때만 쓴다 */
export const BLOCK_SEC = 600;


/** 기한이 이만큼 안 남았으면 클레임을 받지 않는다 — 유저 앱 오더북과 같은 값(shared) */
export const MIN_CLAIM_LEAD_SEC = LN_MIN_CLAIM_LEAD_SEC;

/** 에스크로 결제 창의 상한 (예전 `ESCROW_WINDOW_MAX_SEC`) */
export const ESCROW_PAY_WINDOW_SEC = 24 * HOUR;

/** 에스크로 결제는 기한 이만큼 전에 끝나야 한다 — 그 뒤에 결제해 봐야 원화가 갈 시간이 없다 */
export const ESCROW_PAY_LEAD_SEC = 30 * MIN;

/** 승인할 때 결제 창이 이보다 짧으면 승인하지 않는다 (의미 없는 에스크로) */
export const MIN_ESCROW_PAY_WINDOW_SEC = 10 * MIN;

/** 에스크로 HTLC가 결제 창 뒤로 더 사는 시간 — 송금 완료·입금 확인·분쟁 여유 (예전 `DISPUTE_MARGIN`) */
export const ESCROW_HOLD_MARGIN_SEC = 48 * HOUR;

/**
 * 기한 뒤 유예 — 기한 직전에 송금하고 버튼이 늦는 경우. 이 안에 온 송금 완료·입금 확인은 받는다.
 * `escrowed`·`invoiced`에만 준다(그 앞은 원화가 갈 수 없는 상태라 기다릴 게 없다).
 */
export const DEADLINE_GRACE_SEC = 1 * HOUR;

/** 후원자 보증금 결제 창 — 못 내면 클레임이 풀린다(공짜 점유 차단, AUDIT-EXPIRY F6) */
export const SPONSOR_DEPOSIT_PAY_SEC = 15 * MIN;

/** 고객 보증금 결제 창 — 의뢰를 올린 사람은 지금 앱을 보고 있다 */
export const CUSTOMER_DEPOSIT_PAY_SEC = 1 * HOUR;

/** 고객 보증금이 기한 뒤로 더 살아야 하는 시간 (몰수는 에스크로 전까지만 일어난다) */
export const CUSTOMER_DEPOSIT_MARGIN_SEC = 1 * DAY;

/** 후원자 보증금은 분쟁 판정까지 살아야 한다 — 기한 + 유예 + 에스크로 HTLC 여유 + 하루 */
export const SPONSOR_DEPOSIT_MARGIN_SEC = DEADLINE_GRACE_SEC + ESCROW_HOLD_MARGIN_SEC + 1 * DAY;

/** 받는 쿠팡 기한의 상한 — 근거는 shared `LN_MAX_DEADLINE_LEAD_SEC` (유저 앱 입력 폼과 같은 값) */
export const MAX_DEADLINE_LEAD_SEC = LN_MAX_DEADLINE_LEAD_SEC;

/** 우리가 요구하는 최종 CLTV의 상한 — 경로 델타가 붙어도 2016 안쪽에 들게 */
export const CLTV_MAX_BLOCKS = 1500;

/** LND가 받는 최종 CLTV 하한 근처 — 너무 짧은 홀드는 만들지 않는다 */
export const CLTV_MIN_BLOCKS = 40;

/** 후원자 인보이스 최소 잔여 수명 (예전 `MIN_INVOICE_LIFETIME_SEC`) */
export const MIN_SPONSOR_INVOICE_LIFETIME_SEC = 6 * HOUR;

/**
 * 선제 settle — `remitted`인데 에스크로 HTLC가 이만큼 안 남으면 먼저 받아 둔다(비대칭 손실 원칙).
 * LND는 만기 12블록(`holdexpirydelta` 기본값) 전에 홀드를 스스로 취소하므로 그보다 넉넉히.
 */
export const SAFETY_SETTLE_BLOCKS = 36;

/**
 * `escrowed`·`invoiced`인데 에스크로 HTLC가 이만큼 안 남으면 닫는다(기한 만료와 같은 사유로).
 *
 * CLTV는 기한 + 유예 + 48h를 덮게 잡으므로 평소엔 기한이 먼저 온다. 블록이 빨리 나오면 그 여유가
 * 줄어든다 — 에스크로가 먼저 죽으면 후원자가 **죽은 에스크로를 보고** 원화를 보낼 수 있다.
 */
export const ESCROW_END_BLOCKS = 72;

/** 후원자 인보이스를 받으려면 에스크로가 이만큼은 더 살아야 한다 (송금·확인이 들어갈 틈) */
export const INVOICE_ESCROW_MIN_BLOCKS = ESCROW_END_BLOCKS + 36;

/** `remitted`가 이만큼 고객 확인 없이 머물면 사람을 부른다 */
export const REMITTED_ALERT_SEC = 12 * HOUR;

/**
 * 결제 기한(`pay_by`)을 넘겼다고 판단할 때 주는 여유 — 노드 시계와 우리 시계가 조금 달라도
 * "기한 직전에 낸 결제"를 미납으로 치지 않게. 노드는 인보이스 만료 뒤의 HTLC를 받지 않는다.
 */
export const PAY_BY_SKEW_SEC = 60;

/** 재시작 직후 이 시간 동안은 기한 만료로 닫지 않는다 — 꺼져 있던 동안 쌓인 요청을 먼저 받는다 */
export const CATCHUP_WARMUP_SEC = 2 * MIN;

/** 효과가 이만큼 실패하면 사람을 부른다 (지급 실패·settle 실패 — L-4) */
export const STUCK_EFFECT_ATTEMPTS = 6;

/** 초 단위 기간 → 최종 CLTV 블록 수 (상·하한 안으로) */
export function cltvBlocksFor(spanSec: number): number {
  const blocks = Math.ceil(Math.max(0, spanSec) / BLOCK_SEC);
  return Math.min(CLTV_MAX_BLOCKS, Math.max(CLTV_MIN_BLOCKS, blocks));
}

/** 에스크로 결제 기한 — 24시간 또는 쿠팡 기한 30분 전 중 이른 쪽 */
export function escrowPayBy(deadline: number, nowSec: number): number {
  return Math.min(nowSec + ESCROW_PAY_WINDOW_SEC, deadline - ESCROW_PAY_LEAD_SEC);
}
