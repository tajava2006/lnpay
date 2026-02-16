import type { Event } from 'nostr-tools/core';
import { decode } from 'light-bolt11-decoder';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { SAJWO_REQUEST_KIND } from '@sajwo-tracker/shared';

// ── 어드민 클레임 상태 ─────────────────────────────

export type AdminClaimStatus = 'pending' | 'approved' | 'rejected';

// ── 디코딩된 bolt11 인보이스 ───────────────────────

export interface DecodedBolt11 {
  /** 수신 노드 pubkey (hex) */
  destination: string;
  /** 금액 (satoshi) */
  amountSat: number;
  /** payment hash (hex) — 프로빙에서 절대 사용 금지 */
  paymentHash: string;
  /** 만료 시각 (unix seconds) */
  expiresAt: number;
}

// ── 인보이스 정보 (bolt11 + 디코딩 결과 + 유동성 검증) ──

export interface Invoice {
  /** 원본 bolt11 문자열 */
  bolt11: string;
  /** 디코딩 결과 (디코딩 실패 시 null) */
  decoded: DecodedBolt11 | null;
  /** 인바운드 유동성 검증 완료 여부 */
  liquidityVerified: boolean;
}

// ── 클레임 이벤트 (kind 1111) ─────────────────────

export interface ClaimEvent {
  /** 클레임 이벤트 ID */
  id: string;
  /** 후원자 pubkey */
  sponsorPubkey: string;
  /** 참조된 주문의 고객 pubkey (a-tag에서 추출) */
  customerPubkey: string;
  /** 참조된 주문 ID (a-tag에서 추출) */
  orderId: string;
  /** 참조된 주문 이벤트 ID (e-tag) */
  orderEventId: string | null;
  /** 인보이스 정보 (bolt11 태그가 없으면 null) */
  invoice: Invoice | null;
  /** 클레임 생성 시각 (unix seconds) */
  createdAt: number;
  /** 어드민 처리 상태 */
  status: AdminClaimStatus;
  /** 원본 Nostr 이벤트 */
  raw: Event;
}

// ── bolt11 서명에서 수신 노드 pubkey 복원 ─────────

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** 5-bit word 배열을 8-bit 바이트 배열로 변환 */
function wordsToBytes(words: number[]): Uint8Array {
  let bits = 0;
  let value = 0;
  const result: number[] = [];
  for (const w of words) {
    value = (value << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      result.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(result);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * bolt11 인보이스의 ECDSA 서명에서 수신 노드의 pubkey를 복원한다.
 * BOLT #11: 서명 대상 = SHA256(hrp_utf8 || data_5bit_values_as_bytes)
 */
function recoverDestination(invoice: string): string | null {
  try {
    const lower = invoice.trim().toLowerCase();
    const sepIdx = lower.lastIndexOf('1');
    if (sepIdx < 0) return null;

    const hrp = lower.slice(0, sepIdx);
    const dataChars = lower.slice(sepIdx + 1, -6); // bech32 checksum 제거

    const words: number[] = [];
    for (const ch of dataChars) {
      const val = BECH32_CHARSET.indexOf(ch);
      if (val < 0) return null;
      words.push(val);
    }

    // 마지막 104개 5-bit word = 서명 (512bit sig + 8bit recovery = 520bit)
    if (words.length < 104) return null;
    const dataWords = words.slice(0, -104);
    const sigWords = words.slice(-104);

    const sigBytes = wordsToBytes(sigWords);
    if (sigBytes.length !== 65) return null;

    // BOLT #11: message = SHA256(hrp_utf8 || 각 5-bit 값을 1바이트로)
    const hrpBytes = new TextEncoder().encode(hrp);
    const msg = new Uint8Array(hrpBytes.length + dataWords.length);
    msg.set(hrpBytes);
    msg.set(new Uint8Array(dataWords), hrpBytes.length);
    const hash = sha256(msg);

    // BOLT #11: r(32) || s(32) || recovery(1)
    // @noble/curves: recovery(1) || r(32) || s(32)
    const sig65 = new Uint8Array(65);
    sig65[0] = sigBytes[64];
    sig65.set(sigBytes.subarray(0, 64), 1);
    const pubkey = secp256k1.recoverPublicKey(sig65, hash);

    return bytesToHex(pubkey);
  } catch {
    return null;
  }
}

// ── bolt11 디코딩 ─────────────────────────────────

/**
 * bolt11 문자열을 디코딩한다.
 * light-bolt11-decoder로 금액/해시/만료를, 서명 복원으로 수신 노드를 추출.
 * 디코딩 실패 시 콘솔에 경고를 남기고 null 반환.
 */
function decodeBolt11(bolt11: string): DecodedBolt11 | null {
  try {
    const result = decode(bolt11);
    const sections = result.sections;

    const destination = recoverDestination(bolt11);
    if (!destination) return null;

    const amountSection = sections.find(s => s.name === 'amount');
    const amountMsat = amountSection && 'value' in amountSection
      ? Number(amountSection.value)
      : null;
    if (!amountMsat || amountMsat <= 0) return null;

    const hashSection = sections.find(s => s.name === 'payment_hash');
    const paymentHash = hashSection && 'value' in hashSection
      ? (hashSection.value as string)
      : '';

    const tsSection = sections.find(s => s.name === 'timestamp');
    const timestamp = tsSection && 'value' in tsSection ? (tsSection.value as number) : 0;
    const expiresAt = timestamp + result.expiry;

    return {
      destination,
      amountSat: Math.floor(amountMsat / 1000),
      paymentHash,
      expiresAt,
    };
  } catch (e) {
    console.warn('[decodeBolt11] 디코딩 실패:', e);
    return null;
  }
}

/**
 * kind 1111 이벤트를 ClaimEvent로 파싱한다.
 * a-tag에서 주문 정보를 추출하며, 유효하지 않으면 null 반환.
 */
export function parseClaimEvent(event: Event): ClaimEvent | null {
  // a-tag: "30402:<customer-pubkey>:<orderId>"
  const aTag = event.tags.find(t => t[0] === 'a')?.[1];
  if (!aTag) return null;

  const parts = aTag.split(':');
  if (parts.length < 3 || parts[0] !== String(SAJWO_REQUEST_KIND)) return null;

  const customerPubkey = parts[1];
  const orderId = parts[2];

  const orderEventId = event.tags.find(t => t[0] === 'e')?.[1] ?? null;
  const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1] ?? null;

  const invoice: Invoice | null = bolt11
    ? { bolt11, decoded: decodeBolt11(bolt11), liquidityVerified: false }
    : null;

  return {
    id: event.id,
    sponsorPubkey: event.pubkey,
    customerPubkey,
    orderId,
    orderEventId,
    invoice,
    createdAt: event.created_at,
    status: 'pending',
    raw: event,
  };
}

// ── 주문 참조 정보 (kind 30402) ───────────────────

export interface OrderRef {
  orderId: string;
  pubkey: string;
  price: number;
  currency: string;
  expiresAt: number | null;
  createdAt: number;
  /** 원본 Nostr 이벤트 */
  raw: Event;
}

/**
 * kind 30402 이벤트를 OrderRef로 파싱한다.
 */
export function parseOrderEvent(event: Event): OrderRef | null {
  const dTag = event.tags.find(t => t[0] === 'd')?.[1];
  if (!dTag) return null;

  const priceTag = event.tags.find(t => t[0] === 'price');
  const price = priceTag?.[1] ? Number(priceTag[1]) : 0;
  const currency = priceTag?.[2] ?? 'KRW';

  const expirationTag = event.tags.find(t => t[0] === 'expiration')?.[1];
  const expiresAt = expirationTag ? Number(expirationTag) : null;

  return {
    orderId: dTag,
    pubkey: event.pubkey,
    price,
    currency,
    expiresAt,
    createdAt: event.created_at,
    raw: event,
  };
}
