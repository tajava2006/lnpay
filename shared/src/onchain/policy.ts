/**
 * 받아들일 값의 경계 (PLAN-ONCHAIN-TRACK §6.1b · §2.4 · 리뷰 #8)
 *
 * 유저가 정하는 값 중 **거래를 망가뜨릴 수 있는 것**의 경계를 한 곳에 둔다.
 * 어드민이 거절할 때와 유저 앱이 폼에서 막을 때 **같은 함수**를 쓴다 —
 * 둘이 갈리면 앱은 통과시켰는데 어드민이 거절하는 헛걸음이 생긴다.
 *
 * 전부 "문제가 있으면 사유 문자열, 없으면 `null`"을 돌려준다. 거절 사유는
 * 유저에게 그대로 보여준다.
 */

/**
 * 릴리스 feerate 하한 (sat/vB). 이보다 낮으면 노드가 중계를 안 해 **릴리스가
 * 브로드캐스트조차 안 된다** — CPFP도 못 붙인다(부모가 멤풀에 없으므로).
 */
export const MIN_RELEASE_FEERATE = 1;

/**
 * 릴리스 feerate 상한을 정할 때 쓰는 배수. 지금 "가장 빠른" 추정치의 이 배수까지는
 * 급한 후원자의 선택으로 존중한다.
 */
export const MAX_RELEASE_FEERATE_MULTIPLIER = 5;

/** 상한의 바닥 (sat/vB). 수수료가 아주 낮은 장에서 배수만 쓰면 상한이 너무 낮아진다 */
export const MAX_RELEASE_FEERATE_FLOOR = 100;

/**
 * 릴리스 수수료가 거래액에서 차지할 수 있는 최대 비율.
 *
 * 부담자가 후원자라 원칙상 후원자 마음이지만(§6.1b), **터무니없는 값은 거래 전체를
 * 멈춘다** — 수수료가 거래액을 먹으면 가격을 고정할 수 없어 `bonded`에 영원히
 * 머물고, 고객 BTC는 후원자 보증금이 만료될 때까지 갇힌다. 후원자는 잃는 게 없다
 * (보증금이 저절로 돌아간다) → **공짜 그리핑**이었다(리뷰 #8).
 */
export const MAX_RELEASE_FEE_SHARE = 0.2;

export function releaseFeerateProblem(args: {
  feerateSatPerVb: number;
  /** 지금 "가장 빠른" 추정치. 모르면 상한을 바닥값으로만 본다 */
  fastestSatPerVb?: number;
  amountSat: number;
  /** 이 feerate로 계산한 릴리스 수수료(sat) */
  releaseFeeSat: number;
  /** 받을 주소 종류의 dust 한계 */
  dustSat: number;
}): string | null {
  const { feerateSatPerVb, fastestSatPerVb, amountSat, releaseFeeSat, dustSat } = args;
  if (!Number.isFinite(feerateSatPerVb) || feerateSatPerVb < MIN_RELEASE_FEERATE) {
    return `수수료율은 최소 ${MIN_RELEASE_FEERATE} sat/vB입니다 — 그보다 낮으면 릴리스가 중계되지 않습니다`;
  }
  const ceiling = Math.max(
    MAX_RELEASE_FEERATE_FLOOR,
    (fastestSatPerVb ?? 0) * MAX_RELEASE_FEERATE_MULTIPLIER,
  );
  if (feerateSatPerVb > ceiling) {
    return `수수료율이 너무 높습니다 (최대 ${ceiling} sat/vB)`;
  }
  if (releaseFeeSat > amountSat * MAX_RELEASE_FEE_SHARE) {
    return `수수료가 거래액의 ${MAX_RELEASE_FEE_SHARE * 100}%를 넘습니다`;
  }
  if (amountSat - releaseFeeSat < dustSat) {
    return '수수료를 빼면 받을 금액이 dust 이하입니다';
  }
  return null;
}

/**
 * 최저가(reserve)는 **현재 시세보다 이만큼 이상 낮아야** 받는다.
 *
 * reserve는 원래 "올려두고 잊는" 의뢰를 급락에서 지키는 장치다(IDEA §⑤). 그런데
 * 시세 바로 아래에 걸면 **펀딩 컨펌을 기다리는 동안의 공짜 풋옵션**이 된다 —
 * 컨펌 사이 시세가 내리면 reserve 미달로 무과실 환불(양쪽 보증금 환불), 오르면
 * 그대로 체결. 후원자는 보증금과 시간을 묶인 채 손해 보는 쪽만 떠안는다.
 * "컨펌 시점 고정이면 아무도 옵션을 못 쥔다"(§2.4)가 reserve로 뚫렸다(리뷰 #8).
 *
 * 컨펌 대기(최대 6시간)의 통상 변동폭보다 넓게 잡는다.
 */
export const RESERVE_MIN_GAP_PERCENT = 3;

export function reserveProblem(args: {
  reserveKrw: number;
  amountSat: number;
  /** 지금 시세 (KRW/BTC). 모르면 판단할 수 없다 → 거절 */
  btcPriceKrw: number | undefined;
}): string | null {
  const { reserveKrw, amountSat, btcPriceKrw } = args;
  if (!Number.isFinite(reserveKrw) || reserveKrw <= 0) return '최저가는 원 단위 양수여야 합니다';
  if (btcPriceKrw === undefined || !(btcPriceKrw > 0)) {
    return '지금 시세를 확인할 수 없어 최저가를 걸 수 없습니다. 잠시 후 다시 시도하거나 최저가 없이 등록하세요';
  }
  const spotKrw = (amountSat / 1e8) * btcPriceKrw;
  const ceiling = Math.floor(spotKrw * (1 - RESERVE_MIN_GAP_PERCENT / 100));
  if (reserveKrw > ceiling) {
    return `최저가는 지금 시세보다 ${RESERVE_MIN_GAP_PERCENT}% 이상 낮아야 합니다 `
      + `(지금 기준 최대 ${ceiling.toLocaleString()}원)`;
  }
  return null;
}

/**
 * 서명 전에 보는 **수수료율 상한** (sat/vB). 어드민이 보낸 환불·분쟁 tx가 이보다
 * 비싸면 서명하지 않는다.
 *
 * 받는 주소를 확인해도 **수수료로 태우는 건** 막지 못한다. 악의적인 어드민이
 * 에스크로를 채굴자에게 태워 버리는 그리핑을 막는 마지막 줄이다.
 */
export const MAX_SANE_SETTLEMENT_FEERATE = 1000;

/**
 * 금액별 요구 컨펌 수 (§12 Q1).
 *
 * 공격은 **고객이 자기 펀딩을 되돌리는 것**(§7 E)이고, N컨펌을 되돌리려면 그만한
 * 해시파워를 사야 한다. **그 비용이 거래액을 넘으면 동기가 사라진다.** 1블록
 * 되돌리기도 현실적으로 블록 보상 규모의 기회비용이라 소액에 1컨펌은 충분히 과하다.
 *
 * 어드민(펀딩 판정)과 후원자 앱(송금 전 자체 확인)이 **같은 값**을 봐야 해서 여기 둔다.
 */
export function requiredConfirmations(amountSat: number): number {
  if (!Number.isFinite(amountSat) || amountSat <= 0) {
    throw new Error(`requiredConfirmations: 금액이 비정상이다: ${amountSat}`);
  }
  if (amountSat < 100_000) return 1;
  if (amountSat < 1_000_000) return 2;
  return 3;
}
