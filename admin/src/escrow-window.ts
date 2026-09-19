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
 * 보증금 홀드 인보이스가 살아 있는 시간.
 *
 * ── 왜 에스크로와 따로 두나
 *
 * 둘 다 CLTV 상한에 걸리는 건 같지만 **필요한 길이가 다르다.** 에스크로는 후원자가
 * 붙은 뒤의 거래 구간이라 24시간이면 되고, 보증금은 **의뢰가 오더북에 떠 있는 내내**
 * 살아 있어야 몰수가 가능하다. 에스크로처럼 24시간으로 맞추면 하루 뒤부터 무담보가 된다.
 *
 * ── 왜 그래도 상한이 필요한가
 *
 * 이게 없어서 터진 자리다. 보증금 CLTV는 `(수명 + 24h) / 600`블록인데 의뢰 만료를
 * 그대로 쓰면:
 *
 *   1주   → 1152블록  ✅
 *   1개월 → 4464블록  ❌  채널 max_cltv_expiry(보통 2016)를 넘는다
 *   3개월 → 13104블록 ❌
 *
 * 넘으면 그 의뢰는 보증금을 걸 수 없고, **보증금 결제 후에야 오더가 생기므로
 * 의뢰 등록 자체가 실패**한다.
 *
 * 상한이 CLTV 때문만도 아니다. 홀드 인보이스는 accepted 상태로 **상대 유동성을
 * 붙들고 있다.** 남의 자금을 3개월 잠그는 건 CLTV가 허용하더라도 하면 안 된다
 * (2026-09-19에 CLN askrene이 홀드 하나로 채널을 통째로 막는 걸 겪었다).
 *
 * ⚠️ **알려진 한계**: 7일을 넘는 의뢰는 8일째부터 보증금이 타임아웃 환불되어
 * 무담보로 남는다 — 그 뒤로는 몰수가 불가능하다. 보증금의 주 역할인 **등록 시점
 * 스팸 차단**은 그대로다(등록할 때 이미 결제했으므로).
 */
export const DEPOSIT_WINDOW_MAX_SEC = 7 * 24 * 60 * 60;

/** 보증금 홀드 인보이스 유효시간(초). 의뢰가 더 짧으면 그쪽을 따른다. */
export function depositInvoiceExpiry(orderExpiration: number, now: number): number {
  return Math.min(orderExpiration - now, DEPOSIT_WINDOW_MAX_SEC);
}

/** HTLC가 만료 직전에 아슬아슬하지 않도록 두는 여유. */
export const DEPOSIT_CLTV_MARGIN_SEC = 24 * 60 * 60;

/**
 * 보증금 인보이스에 넘길 `{ 수명, CLTV 블록 }`.
 *
 * ── 왜 둘을 한 함수가 내놓나
 *
 * 원래는 호출부가 수명을 구하고 **직접 CLTV를 계산**했다. 그래서 수명에 상한을
 * 거는 걸 빠뜨리는 순간 CLTV가 조용히 채널 상한을 넘었고, 실제로 그렇게 터졌다.
 * 게다가 `DEPOSIT_CLTV_MARGIN`이 호출부 두 곳에 복붙돼 있어 갈릴 수도 있었다.
 *
 * 둘을 같이 내놓으면 **클램프를 건너뛰고 CLTV만 구하는 경로가 없어진다.**
 * 테스트도 이 함수 하나만 보면 된다.
 */
export function depositInvoiceParams(
  orderExpiration: number,
  now: number,
): { expiry: number; cltvBlocks: number } {
  const expiry = depositInvoiceExpiry(orderExpiration, now);
  return { expiry, cltvBlocks: Math.ceil((expiry + DEPOSIT_CLTV_MARGIN_SEC) / 600) };
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
