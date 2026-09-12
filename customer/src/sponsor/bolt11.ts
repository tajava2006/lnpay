/**
 * Lightning bolt11 invoice 디코딩 및 검증
 *
 * 후원자가 클레임 시 제출하는 invoice의 형식을 검증한다.
 * 서명 검증은 수행하지 않는다 (어드민이 probing으로 실제 유동성을 검증).
 */
import { decode } from 'light-bolt11-decoder';

export interface Bolt11Valid {
  valid: true;
  /** 금액 (millisatoshi). 0-amount invoice면 null */
  amountMsat: number | null;
  /** payment hash (hex) */
  paymentHash: string;
  /** invoice 만료 시각 (unix seconds) */
  expiresAt: number;
}

export interface Bolt11Invalid {
  valid: false;
  error: string;
}

export type Bolt11Result = Bolt11Valid | Bolt11Invalid;

export function decodeBolt11(invoice: string): Bolt11Result {
  const trimmed = invoice.trim().toLowerCase();

  if (!trimmed.startsWith('lnbc') && !trimmed.startsWith('lntb') && !trimmed.startsWith('lntbs')) {
    return { valid: false, error: 'Lightning invoice는 lnbc 또는 lntb로 시작해야 합니다.' };
  }

  let decoded;
  try {
    decoded = decode(trimmed);
  } catch {
    return { valid: false, error: 'Invoice 형식을 파싱할 수 없습니다.' };
  }

  // payment_hash 추출
  const hashSection = decoded.sections.find(s => s.name === 'payment_hash');
  if (!hashSection || !('value' in hashSection)) {
    return { valid: false, error: 'Payment hash가 없는 유효하지 않은 invoice입니다.' };
  }
  const paymentHash = hashSection.value as string;

  // amount 추출 (millisatoshi)
  const amountSection = decoded.sections.find(s => s.name === 'amount');
  let amountMsat: number | null = null;
  if (amountSection && 'value' in amountSection) {
    const raw = amountSection.value as string;
    // light-bolt11-decoder returns amount as a string in millisatoshi
    amountMsat = Number(raw);
    if (Number.isNaN(amountMsat) || amountMsat <= 0) {
      return { valid: false, error: '금액이 0이거나 유효하지 않은 invoice입니다.' };
    }
  } else {
    return { valid: false, error: '금액이 지정되지 않은 invoice입니다. 금액이 포함된 invoice를 사용해 주세요.' };
  }

  // 만료 확인
  const timestampSection = decoded.sections.find(s => s.name === 'timestamp');
  const timestamp = timestampSection && 'value' in timestampSection
    ? (timestampSection.value as number)
    : 0;
  const expiresAt = timestamp + decoded.expiry;

  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now) {
    return { valid: false, error: '이미 만료된 invoice입니다. 새로운 invoice를 생성해 주세요.' };
  }

  return { valid: true, amountMsat, paymentHash, expiresAt };
}
