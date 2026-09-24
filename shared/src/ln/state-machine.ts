/**
 * 라이트닝 트랙 상태 머신 (FSM)
 *
 * 에스크로 거래의 상태 전이 표. **데몬이 유일한 집행자**라(PLAN-DAEMON DM-001) 이 표를 지나야만
 * 오더 상태가 바뀐다. 유저 앱·어드민 앱은 같은 표로 화면을 그린다 — 그래서 shared에 있다.
 */

import type { OrderState } from '../constants';

/**
 * 허용된 상태 전이 맵
 *
 * requested ⇄ claimed → verified → escrowed → invoiced ─→ remitted ─→ paid
 *                                                  │                ├──→ sponsor_wins
 *                                                  └──→ paid        └──→ customer_wins
 *
 * cancelled: requested, claimed, verified에서만 전이 가능
 *   (escrowed 이후는 상대방이 행동할 수 있는 상태이므로 일방 취소 불가)
 *   (remitted는 반드시 분쟁 판정 경로로 종결: paid / sponsor_wins / customer_wins)
 *
 * 터미널: paid, cancelled, sponsor_wins, customer_wins, admin_closed, expired
 *
 * ── `expired` (2026-09-24, PLAN-DAEMON §7 L-2)
 *
 * **쿠팡 가상계좌 기한(`deadline`)이 지나 원화가 더는 갈 수 없는** 거래를 데몬이 닫는 자리다.
 * 예전에는 이런 거래가 아무 전이 없이 화면에서만 사라졌다 — 정리 작업이 의뢰 만료로 오더와
 * 프리이미지를 지웠고, 에스크로는 CLTV까지 묶였다가 저절로 풀렸다. 막바지에 원화를 보낸
 * 후원자는 송금 완료를 눌러도 받아줄 오더가 없었다.
 *
 * `remitted` 이후에는 없다 — 원화가 갔다는 주장이 있으면 분쟁 판정으로 끝낸다.
 * `admin_closed`와 가르는 이유: 사람이 끊은 것과 기한이 끊은 것은 보증금 처리가 다르다
 * (`ln/outcomes.ts`).
 *
 * ── `admin_closed` (2026-09-19)
 *
 * 에스크로가 잡힌 뒤 아무도 움직이지 않는 거래를 어드민이 끊는 자리다. 그대로
 * 두면 홀드 인보이스가 CLTV 타임아웃까지 유동성을 붙들고, 그 채널로 나가는
 * 다른 결제까지 막는다(2026-09-19 실측).
 *
 * `escrowed → cancelled`를 여는 대신 새 상태를 만든 이유: 취소는 고객이 스스로
 * 하는 정상 이탈이고, 그 경로를 열면 T-003(선취적 취소)이 부활한다. 전이 맵에
 * 예외를 내는 것보다 "어드민만 갈 수 있는 종결"을 따로 두는 쪽이 안전하다.
 *
 * ── `escrowed → paid` 지름길을 뺀 이유 (2026-09-18)
 *
 * 후원자 인보이스를 클레임이 아니라 에스크로 이후에 받게 바뀌면서, `escrowed`는
 * **지급 대상이 아직 없는 상태**가 됐다. 거기서 settle하면 BTC를 어드민이 받아
 * 놓고 보낼 곳이 없다. 그래서 그 지름길은 `invoiced → paid`로 옮겼다 —
 * 같은 지름길이되 지급 대상이 확보된 뒤다. 불변조건 I-010.
 *
 * ── `escrowed`/`invoiced`에서 취소를 열지 않는 이유
 *
 * `escrowed`에서는 계좌가 아직 안 나갔으니 후원자가 송금했을 리 없어 안전해
 * 보인다. 하지만 고객이 코드를 고쳐 계좌를 미리 뿌리고 후원자도 고친 코드로
 * 송금하면 T-003(선취적 취소)이 그대로 부활한다. 얻는 건 "멈춘 거래 조기 종료"
 * 정도인데 그건 CLTV 타임아웃이 이미 한다. 열지 않는다.
 */
const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  requested: ['claimed', 'cancelled', 'expired'],
  claimed: ['requested', 'verified', 'cancelled', 'expired'],
  verified: ['escrowed', 'cancelled', 'expired'],
  escrowed: ['invoiced', 'admin_closed', 'expired'],
  invoiced: ['remitted', 'paid', 'admin_closed', 'expired'],
  remitted: ['paid', 'sponsor_wins', 'customer_wins'],
  paid: [],
  cancelled: [],
  sponsor_wins: [],
  customer_wins: [],
  admin_closed: [],
  expired: [],
};

/** 전이 맵에서 유도한 종결 상태 — 손으로 나열하면 갈라진다 */
export const LN_TERMINAL_STATES: ReadonlySet<OrderState> = new Set(
  (Object.keys(TRANSITIONS) as OrderState[]).filter(s => TRANSITIONS[s].length === 0),
);

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 에스크로에 얹는 마진. 라우팅 수수료 재원이자 우리 몫이다. */
const FEE_RATE = 1.005;

/**
 * 후원자가 받을 금액(sat)을 시세로 확정한다. `verified`에서 **한 번만** 부르고,
 * 그 뒤로는 오더에 박혀 아무도 못 바꾼다.
 *
 * 예전에는 후원자가 낸 인보이스 금액이 기준이었고, 그래서 ±5% 범위 검사가
 * 필요했다(신뢰할 수 없는 출처라서). 기준이 어드민으로 오면서 그 검사는
 * 사라졌다 — 방어할 대상 자체가 없어졌다.
 */
export function computePayoutSat(orderPriceKrw: number, btcPriceKrw: number): number | null {
  if (!Number.isFinite(orderPriceKrw) || orderPriceKrw <= 0) return null;
  if (!Number.isFinite(btcPriceKrw) || btcPriceKrw <= 0) return null;
  const sat = Math.round((orderPriceKrw / btcPriceKrw) * 1e8);
  return sat > 0 ? sat : null;
}

/**
 * 고객이 낼 에스크로 금액. **payout에서 파생한다 — 반대가 아니다.**
 *
 * 에스크로를 먼저 정하고 후원자가 ÷1.005로 역산하면 반올림이 1 sat 어긋나
 * 정확 일치 검증이 깨진다. payout을 기준으로 두면 검증이 등식이 된다.
 *
 * `ceil`인 이유: 마진이 최소 1 sat은 남아야 라우팅 수수료를 댄다. `round`면
 * 소액에서 마진이 0이 될 수 있다.
 */
export function computeEscrowSat(payoutSat: number): number {
  return Math.ceil(payoutSat * FEE_RATE);
}

/**
 * 후원자가 제출한 인보이스 금액이 지급 예정액과 **정확히** 일치하는지.
 * 범위가 아니라 등식이다 — 금액을 정한 게 우리라 근사할 이유가 없다.
 */
export function isPayoutAmountExact(payoutSat: number | undefined, amountSat: number): boolean {
  return typeof payoutSat === 'number' && payoutSat > 0 && amountSat === payoutSat;
}

export interface TransitionResult {
  success: boolean;
  error?: TransitionError;
}

export type TransitionError =
  | { type: 'ORDER_NOT_FOUND'; orderId: string }
  | { type: 'INVALID_TRANSITION'; from: OrderState; to: OrderState };
