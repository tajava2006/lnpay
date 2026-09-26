/**
 * Customer 주문 타입 + Admin 이벤트 파싱 + 유저스크립트 파싱 이벤트
 */
import type { Event } from 'nostr-tools/core';
import {
  APP_PUBKEY, MESSAGE_KIND, REQUEST_ACTIONS, isNum, isStr, nip44Decrypt, shape, type AccountInfo, type OrderState,
} from '@sajwo-tracker/shared';
import { parseLnOrderEvent } from '@sajwo-tracker/shared/ln';

/**
 * Customer 로컬 주문
 *
 * 수동 입력 또는 유저스크립트 자동파싱으로 생성되며,
 * 오더 이벤트로 상태가 오버레이된다.
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
  /**
   * 원본 쿠팡 주문번호 (parsed 전용). **절대 발행되지 않는 로컬 전용 필드.**
   *
   * 예전에는 이 값을 orderId로 그대로 써서 공개 a-태그에 실렸다.
   * 실세계 식별자라 상관관계 추적이 가능했고, 남의 번호를 미리 등록해
   * 그 주문을 막는 선점 DoS도 가능했다(A-5). 지금은 orderId가 랜덤이고
   * 이 필드는 중복 감지에만 쓴다.
   */
  coupangOrderId?: string;
  /** 파싱 시 확정된 계좌정보 (parsed 전용, 발송 전 보관) */
  fixedAccountInfo?: AccountInfo;

  // ── Nostr 발행 상태 ──

  /** 발행된 order-request 서명 이벤트 JSON. 없으면 미발행. */
  raw?: string;

  // ── Admin 오버레이 (오더 이벤트에서 수신) ──

  /** Admin FSM 상태. undefined = Admin 미등록. */
  adminState?: OrderState;
  /** Admin verified 전이 시 hold invoice. */
  bolt11?: string;
  /** 보증금 hold invoice (deposit-required 알림에서 수신) */
  depositBolt11?: string;
  /** 보증금 인보이스 상태 (Admin 알림으로 수신, UI 전용) */
  depositStatus?: 'accepted' | 'cancelled' | 'settled';
  /** Admin 오더에서 수신한 Sponsor pubkey (claimed 이후) */
  sponsorPubkey?: string;
  /** 릴레이 보존 기한 (오더 이벤트의 NIP-40) — 목록에서 지우는 기준. 기한(`expiration`)과 다르다 */
  retainUntil?: number;
  /** 종결 사유 (`LnCloseReason`) — 왜 끝났는지 */
  closeReason?: string;
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

/** 받을 때(`parseParsedOrderEvent`)와 저장소에서 읽을 때 같은 확인 — 둘이 다르면 새로고침에 사라진다 */
export const isParsedOrderPayload = shape<ParsedOrderPayload>({
  coupangOrderId: isStr, productName: isStr, price: isNum, bankName: isStr, accountNumber: isStr, depositor: isStr,
  expirationDate: isNum,
});

/**
 * 유저스크립트가 발행한 parsed-order 이벤트를 파싱한다.
 * content는 NIP-44 self-encryption(자기 pubkey로 암호화)되어 있으므로 복호화 필요.
 * 자기 pubkey로 발행된 이벤트만 수신되므로 pubkey 검증은 불필요.
 */
export function parseParsedOrderEvent(event: Event, sk: Uint8Array): ParsedOrderPayload | null {
  if (event.kind !== MESSAGE_KIND) return null;

  const action = event.tags.find(t => t[0] === 'action')?.[1];
  if (action !== REQUEST_ACTIONS.PARSED_ORDER) return null;

  try {
    const plaintext = nip44Decrypt(event.content, sk, event.pubkey);
    const payload: unknown = JSON.parse(plaintext);
    if (!isParsedOrderPayload(payload) || !payload.coupangOrderId || !(payload.price > 0)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 오더 이벤트에서 추출한 갱신 정보 */
export interface AdminOrderUpdate {
  orderId: string;
  adminState: OrderState;
  bolt11?: string;
  sponsorPubkey?: string;
  retainUntil?: number;
  closeReason?: string;
}

/**
 * 오더 이벤트를 파싱하여 Customer 관련 갱신 정보를 추출한다.
 * customer 태그가 myPubkey와 일치하는 이벤트만 처리.
 */
export function parseAdminEvent(event: Event, myPubkey: string): AdminOrderUpdate | null {
  if (event.pubkey !== APP_PUBKEY) return null;

  const customerTag = event.tags.find(t => t[0] === 'customer')?.[1];
  if (customerTag !== myPubkey) return null;

  const orderId = event.tags.find(t => t[0] === 'd')?.[1];
  if (!orderId) return null;

  const order = parseLnOrderEvent(event, APP_PUBKEY);
  if (!order) return null;
  return {
    orderId,
    adminState: order.state,
    bolt11: order.bolt11,
    sponsorPubkey: order.sponsorPubkey,
    retainUntil: order.retainUntil,
    closeReason: order.closeReason,
  };
}

/** 유저스크립트가 보낸 쿠팡 상태 변화 (자기암호화 페이로드) */
export interface CoupangStatusPayload {
  coupangOrderId: string;
  status: 'paid' | 'cancelled';
}

/**
 * coupang-status 이벤트를 복호화해 파싱한다.
 *
 * 유저스크립트가 자기 자신에게 보낸 것이므로 발신자 = 수신자 = 나다.
 */
export function parseCoupangStatusEvent(
  event: Event,
  sk: Uint8Array,
): CoupangStatusPayload | null {
  const action = event.tags.find(t => t[0] === 'action')?.[1];
  if (action !== REQUEST_ACTIONS.COUPANG_STATUS) return null;

  try {
    const plaintext = nip44Decrypt(event.content, sk, event.pubkey);
    const parsed = JSON.parse(plaintext) as CoupangStatusPayload;
    if (!parsed.coupangOrderId) return null;
    if (parsed.status !== 'paid' && parsed.status !== 'cancelled') return null;
    return parsed;
  } catch {
    return null;
  }
}
