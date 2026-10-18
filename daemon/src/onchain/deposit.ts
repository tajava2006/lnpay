/**
 * 온체인 트랙 보증금 산정 — 규칙은 docs/ONCHAIN-TRACK.md §5
 *
 * 보증금은 이탈을 손해로 만드는 장치다. 가격 고정 뒤 옵션 창(최대 105분)의 시세 변동까지 덮는지는
 * 따지지 않기로 했다(운영 결정).
 *
 * ```
 * 보증금 = max( 거래액 × 비율,  4 × 종결 tx 수수료 )
 *                              └ 하한 (절대 sats)
 * ```
 *
 * ⚠️ **하한을 상수로 박으면 안 된다.** 수수료가 1 sat/vB일 때와 50 sat/vB일 때
 * 100배가 난다. 비율만 두면 소액에서 억제력이 0이 된다(1만 sats의 3% = 300 sats,
 * tx 수수료 한 번보다 적다).
 *
 * ── 왜 `4 ×` 인가
 *
 * 후원자가 버리면 고객은 온체인 수수료를 **2회** 잃는다(펀딩 + 환불).
 * 몰수금의 **50%**를 충당에 쓰므로, 그 50%가 2회분을 덮으려면 몰수액이
 * 4회분이어야 한다.
 *
 * ── 고객과 후원자를 같은 값으로 두지 않는다
 *
 * 고객 보증금은 `listed`부터 잠겨 **4배 가까이 오래** 묶이는데, 역할은 더
 * 가볍다(등록 시점 스팸 차단). 그래서 고객 1% / 후원자 3%다.
 *
 * ⚠️ 보증금은 **허들**이기도 하다 — 허들이 높으면 신규가 떠나고 유동성이 마른다. 덮어야 할 것을 덮는
 * 선에서 멈춘다.
 */

import { MAX_TRADE_DURATION_SEC } from '@sajwo-tracker/shared/onchain';

/** 후원자 — 사전서명·송금을 버리면 몰수된다 */
export const SPONSOR_DEPOSIT_PERCENT = 3;

/** 고객 — 등록 시점 스팸 차단. 훨씬 오래 잠기므로 더 작다 */
export const CUSTOMER_DEPOSIT_PERCENT = 1;

/** 몰수금 중 피해자 충당에 쓰는 비율 (운영 재량의 내부 기본값) */
export const COMPENSATION_SHARE = 0.5;

/** 하한 계수 — 후원자가 버리면 고객이 잃는 수수료 2회분을 충당분으로 덮는다 (2 ÷ 50% = 4) */
const FLOOR_MULTIPLIER = 2 / COMPENSATION_SHARE;

/**
 * 보증금 하한(sats). **클레임 시점 feerate로 계산한다.**
 *
 * @param settlementFeeSat 지금 feerate 기준 종결 tx 한 번의 수수료
 */
export function depositFloorSat(settlementFeeSat: number): number {
  if (!Number.isFinite(settlementFeeSat) || settlementFeeSat <= 0) {
    throw new Error(`종결 수수료가 비정상이다: ${settlementFeeSat}`);
  }
  return Math.ceil(settlementFeeSat * FLOOR_MULTIPLIER);
}

/** 실제로 요구할 보증금 = max(비율, 하한) */
export function depositSat(
  amountSat: number,
  percent: number,
  floorSat: number,
): number {
  if (!Number.isInteger(amountSat) || amountSat <= 0) {
    throw new Error(`거래액이 비정상이다: ${amountSat}`);
  }
  return Math.max(Math.ceil((amountSat * percent) / 100), floorSat);
}

/**
 * 최소 거래 금액.
 *
 * 하한이 비율(3%)을 이기는 구간에서는 **실효 보증금이 3%를 넘는다.** 그 지점을
 * 최소 거래액으로 잡으면 어떤 거래도 실효 보증금이 3%를 안 넘는다.
 *
 * ⚠️ **고수수료 장세에서 이 값이 폭등한다.** 그게 온체인 트랙의 실질 한계다 —
 * 수수료가 비쌀 땐 소액이 아예 불가능하고, 그건 **라이트닝 트랙이 할 일**이다.
 * 화면에 "지금은 최소 N sats"를 실시간으로 보여준다.
 */
export function minTradeSat(floorSat: number): number {
  return Math.ceil(floorSat / (SPONSOR_DEPOSIT_PERCENT / 100));
}

/**
 * 보증금 홀드 인보이스의 CLTV(블록).
 *
 * **의뢰 수명 + 거래 최악 소요를 둘 다 덮어야 한다.**
 *
 * 의뢰 만료만 보고 잡으면 **막바지에 클레임된 주문에서 구멍이 난다** — 만료 1시간 전에 클레임이 붙으면
 * 보증금은 하루 남짓 사는데 거래는 `MAX_TRADE_DURATION_SEC`(≈50시간)가 걸릴 수 있다. 그 사이 HTLC가
 * 타임아웃으로 환불되면 몰수라는 억제 장치가 사라진다.
 *
 * ```
 * CLTV = ⌈(남은 의뢰 수명 + 거래 최악 소요 + 6h 여유) ÷ 600⌉
 * ```
 *
 * 의뢰 만료 상한(7일) 덕에 최대 ≈ 1343블록이다. 상한(`CLTV_MAX_BLOCKS`)을 넘는지는 호출부가 보고 거절한다.
 * 이 관계는 `timing-invariants.test.ts`가 지킨다.
 */
const CLTV_SAFETY_MARGIN_SEC = 6 * 3600;

export function depositCltvBlocks(
  expiration: number,
  now: number,
  tradeDurationSec = MAX_TRADE_DURATION_SEC,
): number {
  const remaining = expiration - now;
  if (remaining <= 0) throw new Error('의뢰 만료가 이미 지났다');
  return Math.ceil((remaining + tradeDurationSec + CLTV_SAFETY_MARGIN_SEC) / 600);
}
