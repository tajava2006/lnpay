/**
 * 온체인 워처 (PLAN-ONCHAIN-TRACK §9)
 *
 * "분쟁 때만 사람이 불려 나온다"를 만드는 자리다. 체인과 시계가 진실인 전이는
 * 전부 여기서 자동으로 돈다.
 *
 * ── 판단과 집행을 갈라놨다
 *
 * **무엇을 할지**는 `decide.ts`(순수 함수)가 정하고, 여기서는 **그걸 집행만**
 * 한다. 이 파일이 새 전이를 발명하지 않는다 — 그래야 "어떤 조건에서 무슨 일이
 * 일어나는가"를 네트워크 없이 전수로 검증할 수 있다.
 *
 * ── 의존을 전부 주입받는 이유
 *
 * 릴레이·LN 노드·시세 피드가 다 붙어야 한 틱이 돌아간다. 주입해 두면
 * 테스트가 "리오그가 난 상황", "보증금이 죽은 상황"을 그냥 만들 수 있다.
 */
import {
  FUNDING_WINDOW_SEC, isOnchainTerminal, OUTCOME_RULES,
  type OnchainOrder, type OnchainOutcome, type SettlementKind,
} from '@sajwo-tracker/shared/onchain';
import type { AddressFunds, ChainAdapter, ChainQuery } from './chain';
import { decideOnchainAction, type OnchainAction } from './decide';
import type { OnchainPatch } from './order-store';
import { getPendingSettlement } from './pending-settlement-store';

export interface OnchainWatcherDeps {
  now: () => number;
  chain: ChainAdapter;
  /** 시세 스냅샷 (KRW/BTC). 없으면 가격을 고정하지 않는다 */
  btcPriceKrw: () => number | undefined;
  /** 후원자 보증금이 살아 있는가 (LN 조회). `undefined`는 **모름** (O-015) */
  sponsorBondAlive: (order: OnchainOrder) => Promise<boolean | undefined>;
  /** 고객이 계좌를 공개했는가 */
  accountInfoSent: (orderId: string) => boolean;
  /** 릴리스 수수료 — 후원자가 `bonded`에서 낸 주소·feerate로 계산한다 (§6.1b) */
  releaseFeeSat: (order: OnchainOrder) => number | undefined;
  /** 상태 전이 + 발행. 실패하면 `null` */
  commit: (orderId: string, patch: OnchainPatch) => Promise<OnchainOrder | null>;
  /** 종결 tx를 만들어 상대에게 서명을 요청한다 (pending 생성) */
  prepareSettlement: (order: OnchainOrder, kind: SettlementKind) => Promise<void>;
  /** 보증금 처리 — 사유가 곧 처리다 (§4.1) */
  onOutcome: (order: OnchainOrder, outcome: OnchainOutcome) => void;
  /** 사람을 부른다 */
  raise: (order: OnchainOrder, level: 'anomaly' | 'warn', why: string) => void;
  /** 이번 틱에 돌 오더들 */
  listOrders: () => OnchainOrder[];
  /** 보증금 결제 감시 (phase 0) — 여기서 오더가 생기고 클레임이 성립한다 */
  checkDeposits: () => Promise<void>;
}

/**
 * 한 오더를 한 번 본다.
 *
 * 체인 조회는 **에스크로 주소가 있을 때만** 한다 — `listed`는 주소가 아직 없다.
 */
export async function tickOnchainOrder(
  order: OnchainOrder,
  deps: OnchainWatcherDeps,
): Promise<OnchainAction> {
  if (isOnchainTerminal(order.state)) return { kind: 'idle' };

  const now = deps.now();

  const empty: ChainQuery<AddressFunds> = { known: true, value: { confirmed: [], mempool: [] } };
  const funds = order.escrowAddress
    ? await deps.chain.getAddressFunds(order.escrowAddress)
    : empty;

  const settlementTx = order.state === 'settling' && order.settlementTxid
    ? await deps.chain.getTxStatus(order.settlementTxid)
    : undefined;

  // O-015는 `bonded`에서만 필요하다. 매 틱 LN을 찌를 이유가 없다.
  const sponsorBondAlive = order.state === 'bonded'
    ? await deps.sponsorBondAlive(order)
    : undefined;

  const action = decideOnchainAction(order, {
    now,
    funds,
    settlementTx,
    btcPriceKrw: deps.btcPriceKrw(),
    sponsorBondAlive,
    accountInfoSent: deps.accountInfoSent(order.orderId),
  });

  await executeOnchainAction(order, action, deps);
  return action;
}

export async function executeOnchainAction(
  order: OnchainOrder,
  action: OnchainAction,
  deps: OnchainWatcherDeps,
): Promise<void> {
  const now = deps.now();

  switch (action.kind) {
    case 'idle':
      return;

    case 'hold':
      // 조용히 넘긴다. 매 틱 로그를 남기면 진짜 문제가 묻힌다.
      return;

    case 'anomaly':
      deps.raise(order, 'anomaly', action.why);
      return;

    case 'warn':
      deps.raise(order, 'warn', action.why);
      return;

    case 'fund': {
      const releaseFeeSat = deps.releaseFeeSat(order);
      if (releaseFeeSat === undefined) {
        // 후원자가 `bonded`에서 주소·feerate를 냈어야 한다. 없으면 우리 기록이
        // 깨진 것이라 사람이 봐야 한다 — 가격을 임의로 고정하면 안 된다.
        deps.raise(order, 'anomaly', '릴리스 수수료를 계산할 수 없다 (후원자 주소·feerate 없음)');
        return;
      }
      const payoutSat = order.amountSat - releaseFeeSat;
      if (payoutSat <= 0) {
        deps.raise(order, 'anomaly', `수수료가 거래액을 먹는다 (fee=${releaseFeeSat})`);
        return;
      }

      await deps.commit(order.orderId, {
        state: 'funded',
        fundingOutpoint: `${action.outpoint.txid}:${action.outpoint.vout}`,
        fundingConfs: action.confirmations,
        fundedAt: now,
        priceKrw: action.priceKrw,
        payoutSat,
        releaseFeeSat,
      });
      return;
    }

    case 'fold': {
      // 가격을 고정하지 **않고** funded로 올린 뒤 바로 종결로 간다 (O-015 / reserve).
      const updated = await deps.commit(order.orderId, {
        state: 'funded',
        fundingOutpoint: `${action.outpoint.txid}:${action.outpoint.vout}`,
        fundingConfs: action.confirmations,
        fundedAt: now,
      });
      if (updated) await ensureSettlement(updated, action.settlementKind, deps);
      return;
    }

    case 'cancel': {
      // 사유가 곧 보증금 처리다 — `listed`면 무과실(환불), `bonded`면 고객 몰수.
      const outcome: OnchainOutcome = order.state === 'listed'
        ? (order.expiration > 0 && now >= order.expiration ? 'cancel:expired' : 'cancel:customer')
        : 'cancel:no-funding';

      const updated = await deps.commit(order.orderId, { state: 'cancelled' });
      if (updated) deps.onOutcome(updated, outcome);
      return;
    }

    case 'reorg': {
      // **가격 고정을 폐기하고** `bonded`로 돌아간다 (O-008).
      // 마감을 다시 찍지 않으면 체인 사고로 정직한 고객이 몰수된다(§4.1c).
      await deps.commit(order.orderId, {
        state: 'bonded',
        fundingDeadline: now + FUNDING_WINDOW_SEC,
        fundingOutpoint: undefined,
        fundingConfs: undefined,
        fundedAt: undefined,
        priceKrw: undefined,
        payoutSat: undefined,
        releaseFeeSat: undefined,
        presignedAt: undefined,
        accountSentAt: undefined,
        krwDeadline: undefined,
      });
      deps.raise(order, 'warn', `리오그로 펀딩 확정이 풀렸다 (${action.why}) — 마감을 다시 찍었다`);
      return;
    }

    case 'settle':
      await ensureSettlement(order, action.settlementKind, deps);
      return;

    case 'dispute':
      // **고객 동의를 묻지 않는다** (O-010). 침묵으로 타임락까지 끄는 경로를 막는다.
      await deps.commit(order.orderId, { state: 'disputed' });
      return;

    case 'confirmed': {
      const kind = order.settlementKind;
      if (!kind) {
        deps.raise(order, 'anomaly', '종결이 컨펌됐는데 사유가 없다');
        return;
      }
      const terminal = OUTCOME_RULES[kind].terminal;
      const updated = await deps.commit(order.orderId, { state: terminal });
      if (updated) deps.onOutcome(updated, kind);
      return;
    }
  }
}

/**
 * 종결 tx 준비를 **한 번만** 한다.
 *
 * 이미 대기 중이면 새로 만들지 않는다 — 그 PSBT에는 어드민 서명이 들어 있고
 * 상대가 그걸 받아 서명 중일 수 있다. 새로 만들면 상대가 서명한 tx와 우리가
 * 기다리는 tx가 갈린다.
 */
async function ensureSettlement(
  order: OnchainOrder,
  kind: SettlementKind,
  deps: OnchainWatcherDeps,
): Promise<void> {
  if (getPendingSettlement(order.orderId)) return;
  await deps.prepareSettlement(order, kind);
}

// ─── 폴링 루프 ───────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

/**
 * 30초마다 돈다. 라이트닝 워처(15초)보다 느긋한 이유: 체인은 블록 단위로
 * 움직이고, 공개 mempool.space를 두드리는 빈도이기도 하다.
 */
export function startOnchainWatcher(deps: OnchainWatcherDeps): void {
  if (timer) return;
  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      // phase 0 — 보증금 결제. 오더가 생기고 클레임이 성립하는 자리라 먼저 돈다.
      try {
        await deps.checkDeposits();
      } catch (e) {
        console.warn('[OnchainWatcher] 보증금 감시 실패', e);
      }

      for (const order of deps.listOrders()) {
        try {
          await tickOnchainOrder(order, deps);
        } catch (e) {
          // 한 오더가 터져도 나머지는 돈다.
          console.warn('[OnchainWatcher] 틱 실패', order.orderId, e);
        }
      }
    } finally {
      polling = false;
    }
  };
  void tick();
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
}

export function stopOnchainWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
