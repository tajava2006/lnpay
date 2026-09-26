/**
 * 내가 보낸 온체인 요청으로 로컬 기록을 다시 채운다 — 라이트닝판(`../../nostr/own-requests.ts`)과 같은 원리
 *
 * | 요청 | 되살리는 것 |
 * |---|---|
 * | `onchain-order-request` | 환불 받을 주소 — 서명 요청을 내 기록으로 대조할 때 쓴다(O-021) |
 * | `onchain-claim` | 내가 낸 받을 주소·수수료율 — 사전서명 재료 |
 *
 * 둘 다 APP에게 암호화돼 있고 NIP-44라 내 키로 푼다. 주문별 온체인 키는 nostr 키에서 파생되니 따로 할 게 없다.
 * 의뢰 요청은 의뢰 만료까지만 릴레이에 남는다 — 그 뒤라면 환불 서명 화면이 주소를 다시 묻는다.
 */
import type { Event } from 'nostr-tools/core';
import { APP_PUBKEY, REQUEST_ACTIONS, extractOrderId, nip44Decrypt } from '@sajwo-tracker/shared';
import { isOnchainClaimPayload, isOnchainOrderRequestPayload } from '@sajwo-tracker/shared/onchain';
import { getMyClaim, rememberMyClaim } from '../claim-store';
import { getRefundAddress, rememberRefundAddress } from '../refund-address-store';

function decryptToApp(event: Event, sk: Uint8Array): unknown {
  try {
    return JSON.parse(nip44Decrypt(event.content, sk, APP_PUBKEY)) as unknown;
  } catch {
    return undefined;
  }
}

export function handleOwnOnchainRequest(event: Event, sk: Uint8Array, myPubkey: string): void {
  if (event.pubkey !== myPubkey) return;
  const orderId = extractOrderId(event.tags);
  if (!orderId) return;
  const action = event.tags.find(t => t[0] === 'action')?.[1];

  if (action === REQUEST_ACTIONS.ONCHAIN_ORDER_REQUEST) {
    if (getRefundAddress(orderId)) return;
    const payload = decryptToApp(event, sk);
    if (isOnchainOrderRequestPayload(payload)) rememberRefundAddress(orderId, payload.refundAddress.trim());
    return;
  }

  if (action === REQUEST_ACTIONS.ONCHAIN_CLAIM) {
    // 같은 의뢰에 다시 클레임했으면 마지막 것이 유효하다 — 도착 순서가 아니라 보낸 시각으로 가른다
    const sentAtMs = event.created_at * 1000;
    const known = getMyClaim(orderId);
    if (known && (known.requestedAt ?? 0) >= sentAtMs) return;
    const payload = decryptToApp(event, sk);
    if (!isOnchainClaimPayload(payload)) return;
    rememberMyClaim({
      orderId, payoutAddress: payload.payoutAddress, feerateSatPerVb: payload.feerateSatPerVb, requestedAt: sentAtMs,
    });
  }
}
