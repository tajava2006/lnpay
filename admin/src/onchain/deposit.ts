/**
 * 온체인 트랙 보증금 산정 (PLAN-ONCHAIN-TRACK §6.0)
 *
 * ── 보증금은 스팸 방어가 아니라 **옵션 프리미엄**이다
 *
 * 가격이 T0에 고정된 뒤 후원자는 최대 50분짜리 창을 쥔다(§2.4). 그 구간의
 * **하락 꼬리를 덮지 못하면** "버리는 게 이득"이 되고, 그러면 보증금이
 * 아무것도 억제하지 못한다.
 *
 * ```
 * 보증금 ≥ max( 비율(%),  4 × 종결 tx 수수료 )
 *              └ 옵션 프리미엄   └ 충당 하한 (절대 sats)
 * ```
 *
 * ⚠️ **하한을 상수로 박으면 안 된다.** 수수료가 1 sat/vB일 때와 50 sat/vB일 때
 * 100배가 난다. 비율만 두면 소액에서 억제력이 0이 된다(1만 sats의 3% = 300 sats,
 * tx 수수료 한 번보다 적다).
 *
 * ── 왜 `4 ×` 인가
 *
 * 후원자가 버리면 고객은 온체인 수수료를 **2회** 잃는다(펀딩 + 환불, §6.0).
 * 몰수금의 **50%**를 충당에 쓰므로, 그 50%가 2회분을 덮으려면 몰수액이
 * 4회분이어야 한다.
 *
 * ── 고객과 후원자를 같은 값으로 두지 않는다
 *
 * 고객 보증금은 `listed`부터 잠겨 **4배 가까이 오래** 묶이는데, 역할은 더
 * 가볍다(등록 시점 스팸 차단). 그래서 고객 1% / 후원자 3%다.
 *
 * ⚠️ 보증금은 **허들**이다. IDEA 문서가 이 앱을 만드는 이유로 든 게
 * *"운영자가 허들을 올린다 → 신규 배척 → 유동성 마름"* 이었다.
 * 덮어야 할 것을 덮는 선에서 멈춘다 — 많을수록 좋은 게 아니다.
 */

/** 후원자 — 50분 옵션 창의 하락 꼬리를 덮는다 */
export const SPONSOR_DEPOSIT_PERCENT = 3;

/** 고객 — 등록 시점 스팸 차단. 훨씬 오래 잠기므로 더 작다 */
export const CUSTOMER_DEPOSIT_PERCENT = 1;

/** 몰수금 중 피해자 충당에 쓰는 비율 (운영 재량의 내부 기본값, §6.0) */
export const COMPENSATION_SHARE = 0.5;

/** 하한 계수 — 고객 손실 2회분 ÷ 충당 비율(50%) */
const FLOOR_MULTIPLIER = 4;

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
 * 최소 거래 금액 (§12 Q8).
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
 * **의뢰 수명 전체를 덮어야** 무담보 구간이 안 생긴다(§2.2). 온체인 의뢰 만료를
 * 7일로 묶은 이유가 이것이다 — 채널 상한(보통 2016블록)에 여유 있게 들어간다.
 *
 * ⚠️ 상한은 **런타임에 채널에서 읽어 유도**하는 게 맞다. 여기서는 계산만 하고,
 * 호출부가 상한을 넘는지 확인한다(라이트닝 F1이 그 확인을 빠뜨린 버그다).
 */
export function depositCltvBlocks(expiration: number, now: number, graceSec = 86_400): number {
  const span = expiration - now + graceSec;
  if (span <= 0) throw new Error('의뢰 만료가 이미 지났다');
  return Math.ceil(span / 600);
}
