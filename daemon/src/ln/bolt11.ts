/**
 * bolt11 읽기 — 후원자 인보이스 검증용 (금액·만료·payment hash)
 *
 * 순수 JS 디코더를 쓴다(유저 앱과 같은 것). 서명은 검증하지 않는다 — 금액과 만료만 보고, 실제로
 * 닿는지는 LND 프로빙이 본다. 핸들러는 네트워크 없이 판단해야 해서 LND 디코드를 못 쓴다.
 */
import { decode } from 'light-bolt11-decoder';

export interface Bolt11Info {
  amountSat: number;
  paymentHash: string;
  expiresAt: number;
}

export function readBolt11(bolt11: string): Bolt11Info | null {
  let decoded;
  try {
    decoded = decode(bolt11.trim().toLowerCase());
  } catch {
    return null;
  }
  const section = (name: string) => decoded.sections.find(s => s.name === name);
  const hash = section('payment_hash');
  const amount = section('amount');
  const timestamp = section('timestamp');
  if (!hash || !('value' in hash) || !amount || !('value' in amount)) return null;

  const msat = Number(amount.value);
  if (!Number.isFinite(msat) || msat <= 0 || msat % 1000 !== 0) return null; // sat 단위가 아닌 금액은 받지 않는다
  const issuedAt = timestamp && 'value' in timestamp ? Number(timestamp.value) : 0;
  return {
    amountSat: msat / 1000,
    paymentHash: String(hash.value),
    expiresAt: issuedAt + decoded.expiry,
  };
}
