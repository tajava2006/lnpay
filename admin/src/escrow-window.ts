/**
 * 에스크로 창 — 홀드 인보이스가 살아 있는 시간
 *
 * ── 의뢰 수명과 분리하는 이유
 *
 * 예전엔 홀드 인보이스 만료를 `order.expiration`에 그대로 맞췄다. 의뢰가 하루짜리일
 * 때는 문제가 없었는데, 장기 의뢰("급하지 않으니 한 달쯤 걸어두고 후원자를 기다린다")를
 * 허용하는 순간 깨진다.
 *
 * CLTV가 `(남은시간 + 48h) / 600`블록이라 만료를 1년으로 잡으면 **약 52,800블록**이
 * 된다. 라이트닝 채널의 `max_cltv_expiry`는 보통 2016블록(약 2주)이라 그런 홀드
 * 인보이스는 만들어지지도 결제되지도 않는다 — 후원자가 붙는 순간 터진다.
 *
 * 그런데 긴 시간이 필요한 건 **후원자를 기다리는 구간**이지 거래 자체가 아니다.
 * 후원자가 붙은 뒤로는 몇 시간이면 끝나야 하고, 안 끝나면 그건 한쪽이 불성실하다는
 * 신호지 더 기다려서 해결될 일이 아니다.
 *
 * 그래서 의뢰는 얼마든지 길게, **에스크로 창은 짧게** 가져간다. 유동성이 잠기는
 * 시간이 줄어드는 부수효과도 크다(홀드가 오래 떠 있으면 CLN askrene이 그 채널을
 * 통째로 막아버리는 걸 2026-09-19에 겪었다).
 */

/**
 * 후원자 확정 후 고객이 결제를 마쳐야 하는 시간.
 *
 * 하루면 넉넉하다 — 후원자가 붙은 뒤에도 결제를 안 한다는 건 사실상 이탈이고,
 * 그건 시간을 더 줘서 풀릴 문제가 아니라 보증금으로 다룰 문제다.
 */
export const ESCROW_WINDOW_MAX_SEC = 24 * 60 * 60;

/**
 * 홀드 인보이스에 줄 유효시간(초).
 *
 * 의뢰 만료가 더 가까우면 그쪽을 따른다 — 의뢰가 끝난 뒤까지 살아 있는 에스크로는
 * 의미가 없다.
 */
export function escrowInvoiceExpiry(orderExpiration: number, now: number): number {
  return Math.min(orderExpiration - now, ESCROW_WINDOW_MAX_SEC);
}

/**
 * 이 에스크로가 실제로 만료되는 시각.
 *
 * `order.expiration`을 그대로 쓰면 안 된다. 장기 의뢰에서는 인보이스가 훨씬 먼저
 * 죽는데, 만료 임박 선제 settle(비대칭 손실 방어)이 의뢰 만료만 보고 있으면
 * **영영 안 돈다.** 후원자가 원화를 보냈는데 HTLC가 타임아웃으로 환불되는,
 * 제일 나쁜 결말이 난다.
 *
 * 저장된 엔트리에 별도 필드를 추가하지 않고 `createdAt`에서 되짚는다. 기존 엔트리도
 * 그대로 맞는다 — 예전 의뢰는 만료가 24시간 이내였으므로 min이 의뢰 만료를 고른다.
 */
export function escrowDeadline(orderExpiration: number, entryCreatedAt: number): number {
  return Math.min(orderExpiration, entryCreatedAt + ESCROW_WINDOW_MAX_SEC);
}
