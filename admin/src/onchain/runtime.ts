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
 *
 * ── 소유권 게이트 (§9.1)
 *
 * **자동 경로만** 막는다 — 워처와 요청 처리. 이 둘은 기기가 둘이면 같은 일을
 * 두 번 하고, `listed → bonded`에서는 그게 **에스크로 주소 두 개**가 된다.
 *
 * 어드민이 손으로 누르는 것(분쟁 판정 등)은 막지 않는다. 사람은 한 명이라
 * 두 번 누르지 않고, "폰에서 중재한다"가 다기기 운영의 이유였다.
 */
import type { Event } from 'nostr-tools/core';
import {
  APP_PUBKEY, CLIENT_TAG_ONCHAIN, NOSTR_SINCE, SAJWO_REQUEST_EVENT_KIND,
  SAJWO_REQUEST_KIND, createSubscriptionPool, getReadRelays, storage,
} from '@sajwo-tracker/shared';
import { parseOnchainOrder } from '@sajwo-tracker/shared/onchain';
import type { LightningAdapter } from '../lightning';
import { parseRequestEvent } from '../types';
import { MempoolChainAdapter, type ChainNetwork } from '@sajwo-tracker/shared/onchain';
import {
  accountInfoSent, checkOnchainDeposits, commitOnchainOrder, configureOnchainService,
  handleOnchainClaim, handleOnchainCosign, handleOnchainDispute, handleOnchainOrderRequest,
  handleOnchainCancelRequest, handleOnchainPresig, handleOnchainRemit,
  listOnchainOrders, noteAccountInfoSent,
  onchainReleaseFeeSat, prepareOnchainSettlement,
} from './service';
import { upsertOnchainOrder } from './order-store';
import { startOnchainWatcher, stopOnchainWatcher, type OnchainWatcherDeps } from './watcher';
import {
  canActOnchainNow, claimWatcherLease, getLeaseSnapshot, refreshWatcherLease,
} from './lease';
import { restoreOnchainLocalState, startOnchainBackup, stopOnchainBackup } from './backup';
import { notifyOnchainDisputeSoon } from './notify';
import { handleOnchainOutcome } from './deposit-lifecycle';
import { raiseOnchainAlert } from './alert-store';

export interface OnchainTrackConfig {
  lnAdapter: LightningAdapter;
  /** 시세 스냅샷 (KRW/BTC) */
  btcPriceKrw: () => number | undefined;
  network: ChainNetwork;
  /** 자체 mempool 인스턴스를 쓸 때 */
  chainBaseUrl?: string;
}

let stopSubscription: (() => void) | null = null;

/**
 * 시작이 비동기라 **끝난 뒤에 구독이 살아나는** 경우가 있다 (스위치를 빠르게
 * 껐다 켜거나, 리액트가 이펙트를 두 번 돌릴 때). 세대를 세서 철 지난 시작은
 * 자기 결과를 버린다.
 */
let generation = 0;

/** 마지막으로 본 집행 권한. `false → true`로 바뀌는 순간 구독을 다시 연다 */
let acting = false;

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
      // 보증금 처리는 **사유가 곧 처리**다(§4.1). 표를 그대로 집행한다.
      void handleOnchainOutcome(order, outcome, config.lnAdapter);
    },
    raise: (order, level, why) => {
      // **콘솔에만 남기면 아무도 안 본다.** 대시보드가 집도록 스토어에 올린다.
      raiseOnchainAlert(order, level, why);
      if (level === 'anomaly') {
        console.error('[Onchain] 사람이 봐야 한다:', order.orderId, why);
      } else {
        console.warn('[Onchain]', order.orderId, why);
        if (why.includes('분쟁으로 넘어간다')) notifyOnchainDisputeSoon(order);
      }
    },
    listOrders: listOnchainOrders,
    checkDeposits: checkOnchainDeposits,
    canAct: async () => {
      const snapshot = await refreshWatcherLease();
      if (snapshot.acting && !acting) {
        // 방금 소유권을 얻었다. 그 전에 들어온 요청은 우리가 **버렸으므로**
        // 구독을 다시 열어 릴레이에게 되풀이하게 한다 — 인메모리 큐보다
        // 튼튼하다(기기가 꺼져 있던 동안의 것까지 온다).
        acting = true;
        void resubscribe();
      } else {
        acting = snapshot.acting;
      }
      return snapshot.acting;
    },
  };

  const mine = ++generation;

  // 소유권을 먼저 본다 — 구독을 열기 전에 알아야 요청을 버릴지 말지가 정해진다.
  const snapshot = await refreshWatcherLease();
  if (snapshot.why === 'no-lease') {
    // 아무도 안 잡았다(첫 실행이거나 이전 버전에서 올라왔다). 잡는다.
    // **발행이 실패하면 안 잡힌 것**이다 — 그 경우 워처는 돌지 않는다.
    try {
      await claimWatcherLease();
    } catch (e) {
      console.warn('[Onchain] 워처 소유권 주장 실패 — 관찰만 한다', e);
    }
  }
  if (mine !== generation) return;

  acting = getLeaseSnapshot().acting;

  // 기기 이전으로 잃으면 안 되는 로컬 상태를 먼저 되찾고, 그다음부터 따라 쓴다.
  try {
    await restoreOnchainLocalState();
  } catch (e) {
    console.warn('[Onchain] 로컬 상태 복원 실패', e);
  }
  if (mine !== generation) return;
  startOnchainBackup();

  stopSubscription = await subscribeOnchain();
  if (mine !== generation) {
    stopSubscription();
    stopSubscription = null;
    return;
  }
  startOnchainWatcher(deps);
  console.log('[Onchain] 트랙 시작 —', config.network, '/', getLeaseSnapshot().why ?? '소유권 있음');
}

export function stopOnchainTrack(): void {
  generation += 1;
  acting = false;
  stopOnchainWatcher();
  stopOnchainBackup();
  stopSubscription?.();
  stopSubscription = null;
}

/** 소유권을 얻은 순간 릴레이에 과거를 다시 달라고 한다 */
async function resubscribe(): Promise<void> {
  const mine = generation;
  const next = await subscribeOnchain();
  if (mine !== generation) { next(); return; }
  stopSubscription?.();
  stopSubscription = next;
  console.log('[Onchain] 소유권 획득 — 구독을 다시 열어 놓친 요청을 받는다');
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

  // 소유권이 없는 기기는 **집행하지 않는다** (§9.1). 특히 클레임 —
  // 두 기기가 각자 보증금 인보이스를 내면 후원자가 어느 쪽을 결제했느냐에 따라
  // 한쪽만 그 사실을 알고, 나머지 한쪽의 HTLC는 아무도 안 본다.
  // 버린 요청은 소유권을 얻을 때 구독을 다시 열어 되받는다.
  if (!canActOnchainNow()) return;

  switch (request.action) {
    case 'onchain-order-request': void handleOnchainOrderRequest(request); return;
    case 'onchain-claim': void handleOnchainClaim(request); return;
    case 'onchain-presig': void handleOnchainPresig(request); return;
    case 'onchain-cosign': void handleOnchainCosign(request); return;
    case 'onchain-dispute': void handleOnchainDispute(request); return;

    // 라이트닝과 **같은 액션을 공유**하는 둘 — 뜻과 모양이 같아 새로 만들지
    // 않았다. 트랙은 `t` 태그로 갈리므로 이 구독에는 온체인 것만 들어온다.
    case 'remit-request': void handleOnchainRemit(request); return;
    case 'account-info': void noteAccountInfoSent(request.orderId); return;
    case 'cancel-request': void handleOnchainCancelRequest(request); return;

    default: return;
  }
}
