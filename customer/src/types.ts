/**
 * Customer 주문 타입 + Admin 이벤트 파싱
 *
 * Phase 1: 수동 입력 (쿠팡 자동파싱 없음)
 * Phase 2: 유저스크립트 연동 시 필드 확장 예정
 */
import type { Event } from 'nostr-tools/core';
import { APP_PUBKEY, type OrderState, type AccountInfo } from '@sajwo-tracker/shared';

/**
 * Customer 로컬 주문
 *
 * 수동 입력으로 생성되며, Admin kind 30402 이벤트로 상태가 오버레이된다.
 */
export interface CustomerOrder {
  /** 고유 식별자 (자동 생성) */
  orderId: string;
  /** KRW 금액 */
  price: number;
  /** 사용자 메모 */
  memo: string;
  /** 생성 시각 (Unix seconds) */
  createdAt: number;
  /** 만료 시각 (Unix seconds) */
  expiration: number;

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
