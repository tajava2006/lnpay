/**
 * 데몬 피드 — 리모컨이 보는 것을 전부 구독해 저장소에 넣는다 (헌법의 "Nostr 서비스")
 *
 * | 구독 | 무엇 |
 * |---|---|
 * | `MESSAGE_KIND` · `#p`=운영자 · `#t`=어드민 | 명령 결과, 분쟁 채팅 사본 |
 * | `ADMIN_STATE_KIND` · APP · `#p`=운영자 · `#t`=어드민 | 데몬 상태(하트비트·설정·경보), 오더별 상세 |
 * | `ORDER_KIND` · APP · `#t`=라이트닝/온체인 · `since`=데몬 epoch | 공개 오더 (보기 전용) |
 * | `DESIGNATED_ORDER_KIND` · APP · `#p`=운영자 · `#t`=라이트닝/온체인 · `since`=epoch | 지정 거래 스냅샷 — 열면 공개 오더와 같은 모양 |
 *
 * 지정 거래(docs/PROTOCOL.md §2)는 공개 오더로 안 나간다 — 데몬이 운영자에게도 암호문 스냅샷을 보낸다.
 * 이 구독이 없으면 목록에서 통째로 빠진다. 벙커로 열어 **가짜 오더 이벤트**로 바꾼 뒤 공개 오더와 같은 처리기로 넘긴다.
 *
 * **APP이 서명한 것만** 믿는다 — 운영자 앞으로 온 결과를 아무나 흉내 낼 수 있다.
 * 복호화는 NIP-46 벙커를 거친다(운영자 키).
 *
 * **오더 구독은 데몬 epoch를 알 때만 연다.** 데몬 DB를 새로 시작하면 옛 DB가 같은 APP 키·같은 태그로 낸 오더가
 * 릴레이에 남아 있다(NIP-40을 안 지키는 릴레이도 있다). epoch는 상태 이벤트로 오고, 바뀌면 다시 연다.
 * `since`를 무시하는 릴레이가 있어 받을 때도 거른다.
 */
import type { Event } from 'nostr-tools/core';
import {
  ADMIN_ACTIONS, ADMIN_STATE_KIND, APP_PUBKEY, CLIENT_TAG, CLIENT_TAG_ADMIN, CLIENT_TAG_ONCHAIN, DESIGNATED_ORDER_KIND,
  MESSAGE_KIND, ORDER_KIND, adminOrderDTagPrefix, adminStateDTag, createSubscriptionGuard,
  createSubscriptionPool, designatedOrderFromPlaintext, getReadRelays, storage,
  type AdminChatCopy, type AdminCommandResult, type AdminLnOrderDetail, type AdminOcOrderDetail, type AdminState, nowSec,
} from '@sajwo-tracker/shared';
import { parseOnchainOrder } from '@sajwo-tracker/shared/onchain';
import { parseLnOrderEvent } from '@sajwo-tracker/shared/ln';
import { getSigner } from '../nostr/nip46';
import { receiveResult } from './client';
import {
  chats, daemonEpoch, daemonState, lnDetails, lnOrderAlive, lnOrders, ocDetails, ocOrderAlive, onchainOrders,
  pruneStores, upsertOrder,
} from './stores';

const guard = createSubscriptionGuard('데몬피드');

export function startDaemonFeed(operatorPubkey: string): Promise<void> {
  return guard.start(async () => {
    const relays = await getReadRelays(storage);
    const pool = createSubscriptionPool();

    const inbox = pool.subscribeMany(
      relays,
      { kinds: [MESSAGE_KIND], '#p': [operatorPubkey], '#t': [CLIENT_TAG_ADMIN] },
      { onevent: (event: Event) => void onAdminEvent(event) },
    );
    const stateDTag = adminStateDTag(CLIENT_TAG_ADMIN, operatorPubkey);
    const lnDetailPrefix = adminOrderDTagPrefix(CLIENT_TAG_ADMIN, 'ln');
    const ocDetailPrefix = adminOrderDTagPrefix(CLIENT_TAG_ADMIN, 'onchain');
    const state = pool.subscribeMany(
      relays,
      { kinds: [ADMIN_STATE_KIND], authors: [APP_PUBKEY], '#p': [operatorPubkey], '#t': [CLIENT_TAG_ADMIN] },
      {
        onevent: (event: Event) => {
          const d = event.tags.find(t => t[0] === 'd')?.[1] ?? '';
          if (d === stateDTag) void onStateEvent(event);
          else if (d.startsWith(lnDetailPrefix)) void onLnDetailEvent(event);
          else if (d.startsWith(ocDetailPrefix)) void onOcDetailEvent(event);
        },
      },
    );
    let orders: { close(): void } | null = null;
    let designated: { close(): void } | null = null;
    let ordersSince: number | null = null;
    const syncOrders = () => {
      const epoch = daemonEpoch();
      if (epoch === ordersSince) return;
      orders?.close();
      designated?.close();
      orders = null;
      designated = null;
      ordersSince = epoch;
      if (epoch === null) return;
      orders = pool.subscribeMany(
        relays,
        { kinds: [ORDER_KIND], authors: [APP_PUBKEY], '#t': [CLIENT_TAG, CLIENT_TAG_ONCHAIN], since: epoch },
        { onevent: onOrderEvent },
      );
      designated = pool.subscribeMany(
        relays,
        {
          kinds: [DESIGNATED_ORDER_KIND], authors: [APP_PUBKEY], '#p': [operatorPubkey],
          '#t': [CLIENT_TAG, CLIENT_TAG_ONCHAIN], since: epoch,
        },
        { onevent: (event: Event) => void onDesignatedEvent(event) },
      );
    };
    // 상태가 올 때마다(하트비트 1분) 캐시를 치우고 epoch에 맞춰 구독을 맞춘다
    const tidy = () => {
      pruneStores(nowSec());
      syncOrders();
    };
    tidy();
    const unwatch = daemonState.subscribe(tidy);

    return () => {
      unwatch();
      inbox.close();
      state.close();
      orders?.close();
      designated?.close();
      pool.destroy();
    };
  });
}

export function stopDaemonFeed(): void {
  guard.stop();
}

/** NIP-40 `expiration` — 없으면 undefined */
function retainUntilOf(event: Event): number | undefined {
  const raw = Number(event.tags.find(t => t[0] === 'expiration')?.[1]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
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
    const retainUntil = retainUntilOf(event);
    if (retainUntil !== undefined && retainUntil <= nowSec()) return;
    const detail = await decrypt(event.content) as AdminLnOrderDetail;
    lnDetails.update(prev => {
      const existing = prev[detail.orderId];
      return existing && existing.eventAt >= event.created_at
        ? prev
        : { ...prev, [detail.orderId]: { detail, eventAt: event.created_at, ...(retainUntil ? { retainUntil } : {}) } };
    });
  } catch (e) {
    console.warn('[데몬피드] 오더 상세를 못 열었다', e);
  }
}

async function onOcDetailEvent(event: Event): Promise<void> {
  if (event.pubkey !== APP_PUBKEY) return;
  try {
    const retainUntil = retainUntilOf(event);
    if (retainUntil !== undefined && retainUntil <= nowSec()) return;
    const detail = await decrypt(event.content) as AdminOcOrderDetail;
    ocDetails.update(prev => {
      const existing = prev[detail.orderId];
      return existing && existing.eventAt >= event.created_at
        ? prev
        : { ...prev, [detail.orderId]: { detail, eventAt: event.created_at, ...(retainUntil ? { retainUntil } : {}) } };
    });
  } catch (e) {
    console.warn('[데몬피드] 온체인 상세를 못 열었다', e);
  }
}

/** 이번 세션에 벙커로 연(또는 여는 중인) 지정 스냅샷 `d` → `created_at` */
const openedDesignated = new Map<string, number>();

/**
 * 지정 거래 스냅샷 — 벙커로 열어 공개 오더와 같은 처리기로.
 *
 * **열 필요가 없으면 벙커에 묻지 않는다.** 구독은 `since: epoch`라 다시 열 때마다(탭 전환 등) 보존 중인 스냅샷이 전부
 * 다시 오고, 복호화는 원격 서명기 왕복이다 — N개면 승인 창이 N개 뜰 수 있다(2026-10-18 리뷰). 만료됐거나, 이미 같은·더
 * 새 것을 갖고 있거나(파서가 `updatedAt`을 이벤트 시각으로 둔다), 이번 세션에 이미 열었으면 건너뛴다. 기다리기 전에
 * 적어 두므로 여러 릴레이가 같은 걸 동시에 줘도 한 번만 묻는다.
 */
export async function onDesignatedEvent(event: Event): Promise<void> {
  if (event.pubkey !== APP_PUBKEY) return;
  const retainUntil = retainUntilOf(event);
  if (retainUntil !== undefined && retainUntil <= nowSec()) return;
  const d = event.tags.find(t => t[0] === 'd')?.[1] ?? '';
  const t = event.tags.find(tag => tag[0] === 't')?.[1];
  const orderId = d.slice(0, d.lastIndexOf(':'));
  const known = t === CLIENT_TAG ? lnOrders.get()[orderId] : t === CLIENT_TAG_ONCHAIN ? onchainOrders.get()[orderId] : undefined;
  if (known && known.updatedAt >= event.created_at) return;
  if ((openedDesignated.get(d) ?? -1) >= event.created_at) return;
  const signer = getSigner();
  if (!signer) return;
  openedDesignated.set(d, event.created_at);
  try {
    const opened = designatedOrderFromPlaintext(event, await signer.nip44Decrypt(APP_PUBKEY, event.content));
    if (opened) onOrderEvent(opened);
    else console.warn('[데몬피드] 지정 거래 스냅샷 모양이 아니다', event.id.slice(0, 8));
  } catch (e) {
    openedDesignated.delete(d); // 다음 재생에 다시 묻는다
    console.warn('[데몬피드] 지정 거래 스냅샷을 못 열었다', e);
  }
}

function onOrderEvent(event: Event): void {
  const t = event.tags.find(tag => tag[0] === 't')?.[1];
  const epoch = daemonEpoch();
  if (epoch === null || event.created_at < epoch) return;
  if (t === CLIENT_TAG) {
    const order = parseLnOrderEvent(event, APP_PUBKEY);
    if (order) upsertOrder(lnOrders, order, lnOrderAlive(order, epoch, nowSec()));
  } else if (t === CLIENT_TAG_ONCHAIN) {
    const order = parseOnchainOrder(event, CLIENT_TAG_ONCHAIN);
    if (order) upsertOrder(onchainOrders, order, ocOrderAlive(order, epoch, nowSec()));
  }
}
