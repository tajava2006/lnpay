/**
 * 온체인 트랙 부팅 (PLAN-ONCHAIN-TRACK §1.2)
 *
 * 구독·워처·핸들러를 **한 줄로 붙였다 뗐다** 할 수 있게 모아둔 곳이다.
 * 라이트닝 트랙은 지금 실제 돈이 돌고 있으므로, 온체인이 켜지든 꺼지든
 * 거기에 영향이 없어야 한다.
 *
 * ── 구독을 따로 여는 이유 (§1.3)
 *
 * 필터가 `CLIENT_TAG_ONCHAIN`이라 라이트닝 구독과 **한 소켓에 못 섞는다.**
 * 섞으면 구버전 클라이언트가 온체인 오더를 라이트닝으로 렌더링하는 그 사고가
 * 어드민 쪽에서 재현된다.
 */
import type { Event } from 'nostr-tools/core';
import {
  APP_PUBKEY, CLIENT_TAG_ONCHAIN, NOSTR_SINCE, SAJWO_REQUEST_EVENT_KIND,
  SAJWO_REQUEST_KIND, createSubscriptionPool, getReadRelays, storage,
} from '@sajwo-tracker/shared';
import { parseOnchainOrder } from '@sajwo-tracker/shared/onchain';
import type { LightningAdapter } from '../lightning';
import { parseRequestEvent } from '../types';
import { MempoolChainAdapter, type ChainNetwork } from './chain';
import {
  accountInfoSent, checkOnchainDeposits, commitOnchainOrder, configureOnchainService,
  handleOnchainClaim, handleOnchainCosign, handleOnchainDispute, handleOnchainOrderRequest,
  handleOnchainPresig, listOnchainOrders, onchainReleaseFeeSat, prepareOnchainSettlement,
} from './service';
import { upsertOnchainOrder } from './order-store';
import { startOnchainWatcher, stopOnchainWatcher, type OnchainWatcherDeps } from './watcher';
import { notifyOnchainDisputeSoon } from './notify';

export interface OnchainTrackConfig {
  lnAdapter: LightningAdapter;
  /** 시세 스냅샷 (KRW/BTC) */
  btcPriceKrw: () => number | undefined;
  network: ChainNetwork;
  /** 자체 mempool 인스턴스를 쓸 때 */
  chainBaseUrl?: string;
}

let stopSubscription: (() => void) | null = null;

export async function startOnchainTrack(config: OnchainTrackConfig): Promise<void> {
  const chain = new MempoolChainAdapter({
    network: config.network,
    baseUrl: config.chainBaseUrl,
  });

  configureOnchainService({
    lnAdapter: config.lnAdapter,
    chain,
    network: config.network,
  });

  const deps: OnchainWatcherDeps = {
    now: () => Math.floor(Date.now() / 1000),
    chain,
    btcPriceKrw: config.btcPriceKrw,
    sponsorBondAlive: async order => {
      if (!order.sponsorDepositHash) return undefined;
      try {
        const status = await config.lnAdapter.lookupHoldInvoice(order.sponsorDepositHash);
        // `accepted`만 살아 있는 것이다. `cancelled`는 CLTV 만료로 이미 환불됐다는 뜻.
        return status === 'accepted';
      } catch {
        // ⚠️ 모르는 걸 '죽었다'로 치면 멀쩡한 거래를 접는다 (O-015).
        return undefined;
      }
    },
    accountInfoSent,
    releaseFeeSat: onchainReleaseFeeSat,
    commit: commitOnchainOrder,
    prepareSettlement: prepareOnchainSettlement,
    onOutcome: (order, outcome) => {
      // 보증금 처리는 **사유가 곧 처리**다(§4.1). 실제 settle/cancel 배선은
      // 라이트닝 쪽 deposit-lifecycle과 같은 자리로 붙인다(P5).
      console.log('[Onchain] 종결', order.orderId, outcome);
    },
    raise: (order, level, why) => {
      if (level === 'anomaly') {
        console.error('[Onchain] 사람이 봐야 한다:', order.orderId, why);
      } else {
        console.warn('[Onchain]', order.orderId, why);
        if (why.includes('분쟁으로 넘어간다')) notifyOnchainDisputeSoon(order);
      }
    },
    listOrders: listOnchainOrders,
    checkDeposits: checkOnchainDeposits,
  };

  stopSubscription = await subscribeOnchain();
  startOnchainWatcher(deps);
  console.log('[Onchain] 트랙 시작 —', config.network);
}

export function stopOnchainTrack(): void {
  stopOnchainWatcher();
  stopSubscription?.();
  stopSubscription = null;
}

async function subscribeOnchain(): Promise<() => void> {
  const relays = await getReadRelays(storage);
  const pool = createSubscriptionPool();

  const requestSub = pool.subscribeMany(
    relays,
    {
      kinds: [SAJWO_REQUEST_EVENT_KIND],
      '#p': [APP_PUBKEY],
      '#t': [CLIENT_TAG_ONCHAIN],
      ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
    },
    { onevent: (event: Event) => dispatchOnchainRequest(event) },
  );

  const orderSub = pool.subscribeMany(
    relays,
    {
      kinds: [SAJWO_REQUEST_KIND],
      authors: [APP_PUBKEY],
      '#t': [CLIENT_TAG_ONCHAIN],
      ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
    },
    {
      onevent: (event: Event) => {
        // 자기 에코. 다른 기기에서 발행한 것도 여기로 들어온다.
        const order = parseOnchainOrder(event, CLIENT_TAG_ONCHAIN);
        if (order) upsertOnchainOrder(order);
      },
    },
  );

  return () => {
    requestSub.close();
    orderSub.close();
    pool.destroy();
  };
}

/** action → 핸들러. 온체인 액션만 집는다 — 라이트닝 것은 라이트닝 구독이 받는다 */
export function dispatchOnchainRequest(event: Event): void {
  const request = parseRequestEvent(event);
  if (!request) return;

  switch (request.action) {
    case 'onchain-order-request': void handleOnchainOrderRequest(request); return;
    case 'onchain-claim': void handleOnchainClaim(request); return;
    case 'onchain-presig': void handleOnchainPresig(request); return;
    case 'onchain-cosign': void handleOnchainCosign(request); return;
    case 'onchain-dispute': void handleOnchainDispute(request); return;
    default: return;
  }
}
