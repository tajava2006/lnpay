/**
 * 데몬 피드 — 리모컨이 보는 것을 전부 구독해 저장소에 넣는다 (헌법의 "Nostr 서비스")
 *
 * | 구독 | 무엇 |
 * |---|---|
 * | kind 1111 · `#p`=운영자 · `#t`=어드민 | 명령 결과, 분쟁 채팅 사본 |
 * | kind 30078 · APP · `#p`=운영자 · `#t`=어드민 | 데몬 상태(하트비트·설정·경보), 오더별 상세 |
 * | kind 30402 · APP · `#t`=라이트닝/온체인 | 공개 오더 (보기 전용) |
 *
 * **APP이 서명한 것만** 믿는다 — 운영자 앞으로 온 결과를 아무나 흉내 낼 수 있다.
 * 복호화는 NIP-46 벙커를 거친다(운영자 키).
 */
import type { Event } from 'nostr-tools/core';
import {
  ADMIN_ACTIONS, ADMIN_STATE_KIND, APP_PUBKEY, CLIENT_TAG, CLIENT_TAG_ADMIN, CLIENT_TAG_ONCHAIN,
  SAJWO_REQUEST_EVENT_KIND, SAJWO_REQUEST_KIND, adminOrderDTagPrefix, adminStateDTag, createSubscriptionGuard,
  createSubscriptionPool, getReadRelays, storage,
  type AdminChatCopy, type AdminCommandResult, type AdminLnOrderDetail, type AdminState,
} from '@sajwo-tracker/shared';
import { parseOnchainOrder } from '@sajwo-tracker/shared/onchain';
import { parseLnOrderEvent } from '@sajwo-tracker/shared/ln';
import { getSigner } from '../nostr/nip46';
import { receiveResult } from './client';
import { chats, daemonState, lnDetails, lnOrders, onchainOrders } from './stores';

const guard = createSubscriptionGuard('데몬피드');

export function startDaemonFeed(operatorPubkey: string): Promise<void> {
  return guard.start(async () => {
    const relays = await getReadRelays(storage);
    const pool = createSubscriptionPool();

    const inbox = pool.subscribeMany(
      relays,
      { kinds: [SAJWO_REQUEST_EVENT_KIND], '#p': [operatorPubkey], '#t': [CLIENT_TAG_ADMIN] },
      { onevent: (event: Event) => void onAdminEvent(event) },
    );
    const stateDTag = adminStateDTag(CLIENT_TAG_ADMIN, operatorPubkey);
    const lnDetailPrefix = adminOrderDTagPrefix(CLIENT_TAG_ADMIN, 'ln');
    const state = pool.subscribeMany(
      relays,
      { kinds: [ADMIN_STATE_KIND], authors: [APP_PUBKEY], '#p': [operatorPubkey], '#t': [CLIENT_TAG_ADMIN] },
      {
        onevent: (event: Event) => {
          const d = event.tags.find(t => t[0] === 'd')?.[1] ?? '';
          if (d === stateDTag) void onStateEvent(event);
          else if (d.startsWith(lnDetailPrefix)) void onLnDetailEvent(event);
        },
      },
    );
    const orders = pool.subscribeMany(
      relays,
      { kinds: [SAJWO_REQUEST_KIND], authors: [APP_PUBKEY], '#t': [CLIENT_TAG, CLIENT_TAG_ONCHAIN] },
      { onevent: onOrderEvent },
    );

    return () => {
      inbox.close();
      state.close();
      orders.close();
      pool.destroy();
    };
  });
}

export function stopDaemonFeed(): void {
  guard.stop();
}

async function decrypt(content: string): Promise<unknown> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음');
  return JSON.parse(await signer.nip44Decrypt(APP_PUBKEY, content));
}

async function onAdminEvent(event: Event): Promise<void> {
  if (event.pubkey !== APP_PUBKEY) return;
  const action = event.tags.find(t => t[0] === 'action')?.[1];
  try {
    if (action === ADMIN_ACTIONS.RESULT) {
      const commandId = event.tags.find(t => t[0] === 'e')?.[1];
      if (commandId) receiveResult(commandId, await decrypt(event.content) as AdminCommandResult);
    } else if (action === ADMIN_ACTIONS.CHAT) {
      const copy = await decrypt(event.content) as AdminChatCopy;
      const key = `${copy.track}:${copy.orderId}`;
      chats.update(prev => {
        const list = prev[key] ?? [];
        if (list.some(m => m.originalId === copy.originalId)) return prev;
        return { ...prev, [key]: [...list, copy].sort((a, b) => a.sentAt - b.sentAt) };
      });
    }
  } catch (e) {
    console.warn('[데몬피드] 못 열었다', action, e);
  }
}

async function onStateEvent(event: Event): Promise<void> {
  if (event.pubkey !== APP_PUBKEY) return;
  const current = daemonState.get();
  if (current.eventAt !== null && event.created_at <= current.eventAt) return;
  try {
    const state = await decrypt(event.content) as AdminState;
    // 복호화 중에 더 새것이 들어왔을 수 있다
    if ((daemonState.get().eventAt ?? 0) < event.created_at) daemonState.set({ state, eventAt: event.created_at });
  } catch (e) {
    console.warn('[데몬피드] 상태를 못 열었다', e);
  }
}

async function onLnDetailEvent(event: Event): Promise<void> {
  if (event.pubkey !== APP_PUBKEY) return;
  try {
    const detail = await decrypt(event.content) as AdminLnOrderDetail;
    lnDetails.update(prev => {
      const existing = prev[detail.orderId];
      return existing && existing.eventAt >= event.created_at
        ? prev
        : { ...prev, [detail.orderId]: { detail, eventAt: event.created_at } };
    });
  } catch (e) {
    console.warn('[데몬피드] 오더 상세를 못 열었다', e);
  }
}

function onOrderEvent(event: Event): void {
  const t = event.tags.find(tag => tag[0] === 't')?.[1];
  if (t === CLIENT_TAG) {
    const order = parseLnOrderEvent(event, APP_PUBKEY);
    if (!order) return;
    lnOrders.update(prev => {
      const existing = prev[order.orderId];
      return existing && existing.updatedAt >= order.updatedAt ? prev : { ...prev, [order.orderId]: order };
    });
  } else if (t === CLIENT_TAG_ONCHAIN) {
    const order = parseOnchainOrder(event, CLIENT_TAG_ONCHAIN);
    if (!order) return;
    onchainOrders.update(prev => {
      const existing = prev[order.orderId];
      return existing && existing.updatedAt >= order.updatedAt ? prev : { ...prev, [order.orderId]: order };
    });
  }
}
