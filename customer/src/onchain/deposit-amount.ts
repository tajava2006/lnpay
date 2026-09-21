/**
 * 보증금 인보이스의 금액을 화면에 쓰기 위한 디코딩
 *
 * ⚠️ **얼마인지 안 보이면 결제를 못 한다.** 인보이스 QR만 띄워놓고 금액을
 * 안 적으면 유저가 지갑을 열어봐야 안다 — 특히 온체인 트랙은 보증금이
 * 거래액의 1~3%라 "얼마 나가는지"가 판단에 직접 들어간다.
 *
 * 디코딩이 실패해도 **화면을 깨뜨리지 않는다.** 금액 자리를 비우고 넘어간다 —
 * 인보이스 자체는 지갑이 읽으면 되기 때문이다.
 */
import { decodeBolt11 } from '../sponsor/bolt11';

export function depositAmountSat(bolt11: string): number | null {
  const decoded = decodeBolt11(bolt11);
  if (!decoded.valid || decoded.amountMsat === null) return null;
  return Math.round(decoded.amountMsat / 1000);
}

/** "1,352 sats" 또는 금액을 모르면 빈 문자열 */
export function depositAmountText(bolt11: string): string {
  const sat = depositAmountSat(bolt11);
  return sat === null ? '' : `${sat.toLocaleString()} sats`;
}
