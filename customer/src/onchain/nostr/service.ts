/**
 * 온체인 구독 + 자동 반응 (PLAN-ONCHAIN-TRACK §1.3 · §2.4)
 *
 * 라이트닝 구독과 **소켓을 나눈다.** 필터의 `t` 태그가 달라 한 구독에 못 섞고,
 * 섞으면 구버전 클라이언트가 온체인 오더를 라이트닝으로 렌더링하는 그 사고가
 * 여기서 재현된다(§1.3).
 *
 * ── 자동으로 하는 것은 하나뿐
 *
 * **후원자의 사전서명**이다(§2.4). 받을 주소와 feerate는 클레임 때 이미 냈고
 * 금액은 정해져 있으니 판단할 게 없다 — 15분은 앱이 깨어나는 시간이다.
 *
 * ⚠️ **릴리스 최종 서명은 절대 자동이 아니다**(O-007). 고객이 은행 입금을 눈으로
 * 확인하고 누르는 것이고, 그게 유일한 방어선이다.
 */
import type { Event } from 'nostr-tools/core';
import {
  APP_PUBKEY, CLIENT_TAG_ONCHAIN, NOSTR_SINCE, SAJWO_REQUEST_EVENT_KIND,
  SAJWO_REQUEST_KIND, createSubscriptionPool, createSubscriptionGuard,
  getReadRelays, getSecretKey, getUserPubkey, nip44Decrypt, storage,
} from '@sajwo-tracker/shared';
import { parseAccountInfoEnvelope } from '@sajwo-tracker/shared';
import {
  isOnchainPsbtPayload, parseOnchainOrder, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { getOnchainOrder, roleIn, upsertOnchainOrder } from '../store';
import { buildPresignature } from '../actions';
import { publishOnchainPresig } from './publish';
import { putSignRequest } from '../sign-request-store';
import { putDepositInvoice } from '../deposit-store';
import { forgetPendingRequest, markRequestRejected } from '../pending-request-store';
import { putOnchainAccount } from '../account-store';

const guard = createSubscriptionGuard('온체인구독');

/** 사전서명을 이미 보낸 주문 — 릴레이 에코가 오기 전 중복 발행을 막는다 */
const presigning = new Set<string>();

export function startOnchainSubscriptions(): Promise<void> {
  return guard.start(async () => {
    const [relays, myPubkey] = await Promise.all([
      getReadRelays(storage),
      getUserPubkey(storage),
    ]);

    const pool = createSubscriptionPool();

    const orderSub = pool.subscribeMany(
      relays,
      {
        kinds: [SAJWO_REQUEST_KIND],
        authors: [APP_PUBKEY],
        '#t': [CLIENT_TAG_ONCHAIN],
        ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
      },
      { onevent: (event: Event) => void handleOrderEvent(event, myPubkey) },
    );

    const inboxSub = pool.subscribeMany(
      relays,
      {
        kinds: [SAJWO_REQUEST_EVENT_KIND],
        '#p': [myPubkey],
        '#t': [CLIENT_TAG_ONCHAIN],
        ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
      },
      { onevent: (event: Event) => void handleInboxEvent(event) },
    );

    console.log('[온체인] 구독 시작 —', relays.length, '릴레이');

    return () => {
      orderSub.close();
      inboxSub.close();
      pool.destroy();
      console.log('[온체인] 구독 종료');
    };
  });
}

export function stopOnchainSubscriptions(): void {
  guard.stop();
}

export async function handleOrderEvent(event: Event, myPubkey: string): Promise<void> {
  const order = parseOnchainOrder(event, CLIENT_TAG_ONCHAIN);
  if (!order) return;
  if (!upsertOnchainOrder(order)) return;

  // 오더가 생겼으면 "등록 요청 대기"는 끝났다
  forgetPendingRequest(order.orderId);

  // 후원자 사전서명 — 여기가 자동인 유일한 자리다.
  if (order.state === 'funded' && roleIn(order, myPubkey) === 'sponsor') {
    void autoPresign(order);
  }
}

async function autoPresign(order: OnchainOrder): Promise<void> {
  if (presigning.has(order.orderId)) return;
  presigning.add(order.orderId);
  try {
    const built = await buildPresignature(order);
    if (!built.ok) {
      // 값이 안 맞으면 **서명하지 않는다.** 내가 덜 받는 tx에 서명하는 것보다
      // 마감을 놓치는 게 낫다 — 마감은 보증금만 잃지만 서명은 되돌릴 수 없다.
      console.error('[온체인] 사전서명을 만들 수 없다:', order.orderId, built.reason);
      return;
    }
    const result = await publishOnchainPresig(order.orderId, built.psbt);
    if (!result.success) {
      console.error('[온체인] 사전서명 발행 실패', order.orderId, result.errors);
      presigning.delete(order.orderId); // 다음 에코에 다시 시도
    }
  } finally {
    // 성공했으면 상태가 `presigned`로 바뀌며 이 경로를 더 안 탄다.
    setTimeout(() => presigning.delete(order.orderId), 60_000);
  }
}

export async function handleInboxEvent(event: Event): Promise<void> {
  const action = event.tags.find(t => t[0] === 'action')?.[1];
  const orderId = event.tags.find(t => t[0] === 'a')?.[1]?.split(':')[2];
  if (!action || !orderId) return;

  if (action === 'deposit-required') {
    const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1];
    if (bolt11) {
      putDepositInvoice({ orderId, bolt11, receivedAt: event.created_at });
      // 답이 왔다 — 더 기다릴 게 없다
      forgetPendingRequest(orderId);
    }
    return;
  }

  if (action === 'account-info') {
    /**
     * 고객이 **나에게 직접** 보낸 계좌다(어드민도 못 본다). 이걸 안 다루면
     * 후원자는 **어디로 보낼지 모른 채** 마감 시계만 흐른다.
     * 보낸 사람 키로 푼다 — 어드민 키가 아니다.
     */
    try {
      const sk = await getSecretKey(storage);
      const envelope = parseAccountInfoEnvelope(nip44Decrypt(event.content, sk, event.pubkey));
      if (envelope?.accountInfo) putOnchainAccount(orderId, envelope.accountInfo);
    } catch (e) {
      console.warn('[온체인] 계좌 정보를 못 열었다', orderId, e);
    }
    return;
  }

  if (action === 'onchain-rejected') {
    // **조용히 사라지지 않게 한다.** 사유가 화면에 남아야 유저가 다음을 정한다.
    const reason = event.tags.find(t => t[0] === 'reason')?.[1] ?? '알 수 없는 사유';
    markRequestRejected(orderId, reason);
    return;
  }

  if (action === 'onchain-cosign') {
    // 어드민이 "이 tx에 서명해 달라"고 보낸 것이다. **자동으로 서명하지 않는다** —
    // 화면이 내용을 보여주고 유저가 누른다.
    const purpose = event.tags.find(t => t[0] === 'purpose')?.[1];
    if (!purpose) return;
    try {
      const sk = await getSecretKey(storage);
      const payload: unknown = JSON.parse(nip44Decrypt(event.content, sk, APP_PUBKEY));
      if (!isOnchainPsbtPayload(payload)) return;
      putSignRequest({
        orderId,
        purpose: purpose as 'release' | 'refund' | 'dispute-customer' | 'dispute-sponsor',
        psbt: payload.psbt,
        receivedAt: event.created_at,
      });
    } catch (e) {
      console.warn('[온체인] 서명 요청을 못 열었다', orderId, e);
    }
    return;
  }

  if (action === 'deposit-accepted' || action === 'deposit-cancelled') {
    // 오더 상태가 곧 따라오므로 화면은 그걸 본다. 여기서는 인보이스만 치운다.
    if (action === 'deposit-accepted' || getOnchainOrder(orderId)) {
      putDepositInvoice({ orderId, bolt11: '', receivedAt: event.created_at, done: true });
    }
  }
}
