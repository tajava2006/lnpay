/**
 * Lightning bolt11 invoice 디코딩 (고객용)
 *
 * 결제 금액(sats) 표시를 위해 bolt11에서 금액만 추출한다.
 */
import { decode } from 'light-bolt11-decoder';

export interface DecodedInvoice {
  amountSat: number;
  expiresAt: number;
}

export function decodeBolt11(invoice: string): DecodedInvoice | null {
  const trimmed = invoice.trim().toLowerCase();
  if (!trimmed.startsWith('lnbc') && !trimmed.startsWith('lntb') && !trimmed.startsWith('lntbs')) {
    return null;
  }

  let decoded;
  try {
    decoded = decode(trimmed);
  } catch {
    return null;
  }

  const amountSection = decoded.sections.find(s => s.name === 'amount');
  if (!amountSection || !('value' in amountSection)) return null;
  const amountMsat = Number(amountSection.value as string);
  if (Number.isNaN(amountMsat) || amountMsat <= 0) return null;

  const timestampSection = decoded.sections.find(s => s.name === 'timestamp');
  const timestamp = timestampSection && 'value' in timestampSection
    ? (timestampSection.value as number)
    : 0;

  return {
    amountSat: Math.floor(amountMsat / 1000),
    expiresAt: timestamp + decoded.expiry,
  };
}
