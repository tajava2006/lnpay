/**
 * Customer 주문 타입 + Admin 이벤트 파싱 + 유저스크립트 파싱 이벤트
 */
import type { Event } from 'nostr-tools/core';
import { APP_PUBKEY, SAJWO_REQUEST_EVENT_KIND, REQUEST_ACTIONS, nip44Decrypt, type OrderState, type AccountInfo } from '@sajwo-tracker/shared';

/**
 * Customer 로컬 주문
 *
 * 수동 입력 또는 유저스크립트 자동파싱으로 생성되며,
 * Admin kind 30402 이벤트로 상태가 오버레이된다.
 */
export interface CustomerOrder {
  /** 고유 식별자 (수동: 자동 생성, 파싱: 쿠팡 주문번호) */
  orderId: string;
  /** KRW 금액 */
  price: number;
  /** 사용자 메모 */
  memo: string;
  /** 생성 시각 (Unix seconds) */
  createdAt: number;
  /** 만료 시각 (Unix seconds) */
  expiration: number;

  // ── 주문 출처 ──

  /** 주문 출처. 'parsed'면 계좌정보 잠금 + verified시 자동 전송. */
  source?: 'manual' | 'parsed';
  /** 파싱 시 확정된 계좌정보 (parsed 전용, 발송 전 보관) */
  fixedAccountInfo?: AccountInfo;

  // ── Nostr 발행 상태 ──

  /** 발행된 kind 1111 서명 이벤트 JSON. 없으면 미발행. */
  raw?: string;

  // ── Admin 오버레이 (kind 30402에서 수신) ──

  /** Admin FSM 상태. undefined = Admin 미등록. */
  adminState?: OrderState;
  /** Admin verified 전이 시 hold invoice. */
  bolt11?: string;
  /** Admin 오더에서 수신한 Sponsor pubkey (claimed 이후) */
  sponsorPubkey?: string;
  /** 전달 완료된 계좌정보 (로컬 전용, 재전송 방지) */
  accountInfo?: AccountInfo;
}

/** 유저스크립트 parsed-order 이벤트의 content JSON */
export interface ParsedOrderPayload {
  coupangOrderId: string;
  productName: string;
  price: number;
  bankName: string;
  accountNumber: string;
  depositor: string;
  /** 입금 기한 (milliseconds timestamp) */
  expirationDate: number;
}

/**
 * 유저스크립트가 발행한 kind 1111 parsed-order 이벤트를 파싱한다.
 * content는 NIP-44 self-encryption(자기 pubkey로 암호화)되어 있으므로 복호화 필요.
 * 자기 pubkey로 발행된 이벤트만 수신되므로 pubkey 검증은 불필요.
 */
export function parseParsedOrderEvent(event: Event, sk: Uint8Array): ParsedOrderPayload | null {
  if (event.kind !== SAJWO_REQUEST_EVENT_KIND) return null;

  const action = event.tags.find(t => t[0] === 'action')?.[1];
  if (action !== REQUEST_ACTIONS.PARSED_ORDER) return null;

  try {
    const plaintext = nip44Decrypt(event.content, sk, event.pubkey);
    const payload = JSON.parse(plaintext) as ParsedOrderPayload;
    if (!payload.coupangOrderId || !payload.price) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Admin kind 30402 이벤트에서 추출한 갱신 정보 */
export interface AdminOrderUpdate {
  orderId: string;
  adminState: OrderState;
  bolt11?: string;
  sponsorPubkey?: string;
}

/**
 * Admin kind 30402 이벤트를 파싱하여 Customer 관련 갱신 정보를 추출한다.
 * customer 태그가 myPubkey와 일치하는 이벤트만 처리.
 */
export function parseAdminEvent(event: Event, myPubkey: string): AdminOrderUpdate | null {
  if (event.pubkey !== APP_PUBKEY) return null;

  const customerTag = event.tags.find(t => t[0] === 'customer')?.[1];
  if (customerTag !== myPubkey) return null;

  const orderId = event.tags.find(t => t[0] === 'd')?.[1];
  if (!orderId) return null;

  const adminState = (event.tags.find(t => t[0] === 'state')?.[1] ?? 'requested') as OrderState;
  const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1];
  const sponsorPubkey = event.tags.find(t => t[0] === 'sponsor')?.[1];

  return { orderId, adminState, bolt11, sponsorPubkey };
}
