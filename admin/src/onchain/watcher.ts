/**
 * 온체인 워처 (PLAN-ONCHAIN-TRACK §9)
 *
 * "분쟁 때만 사람이 불려 나온다"를 만드는 자리다. 체인과 시계가 진실인 전이는
 * 전부 여기서 자동으로 돈다.
 *
 * ── 판단과 집행을 갈라놨다
 *
 * **무엇을 할지**는 `decide.ts`(순수 함수)가 정하고, 여기서는 **사실을 모으고
 * 집행만** 한다. 이 파일이 새 전이를 발명하지 않는다 — 그래야 "어떤 조건에서
 * 무슨 일이 일어나는가"를 네트워크 없이 전수로 검증할 수 있다.
 *
 * ── 옛 판단으로 새 상태를 덮지 않는다 (리뷰 #8)
 *
 * 한 틱은 체인 조회를 여러 번 기다린다. 그 사이 요청 핸들러가 오더를 바꿀 수 있다
 * (브로드캐스트 → `settling`). 전에는 틱 시작 때의 스냅샷으로 판단해 그대로 썼고,
 * 방금 뿌린 환불을 리오그로 읽어 `bonded`로 되돌릴 수 있었다. 이제 모든 쓰기는
 * **판단에 쓴 `updatedAt`이 그대로일 때만** 성립한다(`ifUnchangedSince`).
 *
 * ── 의존을 전부 주입받는 이유
 *
 * 릴레이·LN 노드·시세 피드가 다 붙어야 한 틱이 돌아간다. 주입해 두면
 * 테스트가 "리오그가 난 상황", "보증금이 죽은 상황"을 그냥 만들 수 있다.
 */
import {
  FUNDING_WINDOW_SEC, deriveEscrowAddress, isOnchainTerminal, leafOfWitness, OUTCOME_RULES,
  parseOutpoint, settlementLeafFor, settlementPathForKind,
  type OnchainOrder, type OnchainOutcome, type Outpoint, type SettlementKind,
} from '@sajwo-tracker/shared/onchain';
import type { AddressFunds, ChainAdapter, ChainQuery } from '@sajwo-tracker/shared/onchain';
import { decideOnchainAction, type OnchainAction, type PinnedFacts } from './decide';
import { judgePinnedFunding, requiredConfirmations, strayUtxos } from './funding';
import type { OnchainPatch, TransitionGuard } from './order-store';

export interface OnchainWatcherDeps {
  now: () => number;
  chain: ChainAdapter;
  /** 시세 스냅샷 (KRW/BTC). **신선한 것만** 준다 — 없으면 가격을 고정하지 않는다 */
  btcPriceKrw: () => number | undefined;
  /** 후원자 보증금이 살아 있는가 (LN 조회). `undefined`는 **모름** (O-015) */
  sponsorBondAlive: (order: OnchainOrder) => Promise<boolean | undefined>;
  /** 고객이 계좌를 공개했는가 */
  accountInfoSent: (orderId: string) => boolean;
  /** 릴리스 수수료 — 후원자가 `bonded`에서 낸 주소·feerate로 계산한다 (§6.1b) */
  releaseFeeSat: (order: OnchainOrder) => number | undefined;
  /** 상태 전이 + 발행. 실패하면 `null` */
  commit: (orderId: string, patch: OnchainPatch, guard?: TransitionGuard) => Promise<OnchainOrder | null>;
  /**
   * 환불을 **결정**한다 — 수수료를 정해 `refunding`을 발행하고, 보증금을 처리하고,
   * 고객에게 서명을 요청한다. `fold`면 `bonded`에서 바로 간다.
   */
  decideSettlement: (
    order: OnchainOrder,
    kind: SettlementKind,
    opts?: { fold?: { outpoint: Outpoint; confirmations: number } },
  ) => Promise<OnchainOrder | null>;
  /** 결정된 종결의 서명 요청을 (다시) 보낸다 */
  requestSignature: (order: OnchainOrder) => Promise<void>;
  /** 마지막으로 서명 요청을 보낸 시각. 모르면 `undefined` */
  lastSignatureRequestAt: (orderId: string) => number | undefined;
  /** outbox — 브로드캐스트 직전 기록이 있는가, 그 txid는 무엇인가 */
  outboxTxid: (orderId: string) => string | undefined;
  /** outbox를 마무리한다 (발행 → 브로드캐스트) */
  flushOutbox: (order: OnchainOrder) => Promise<void>;
  /** 우리 종결 tx를 다시 뿌린다 */
  rebroadcast: (order: OnchainOrder) => Promise<void>;
  /** 보증금 처리 — 사유가 곧 처리다 (§4.1). **멱등이어야 한다** */
  onOutcome: (order: OnchainOrder, outcome: OnchainOutcome) => void;
  /** 사람을 부른다 */
  raise: (order: OnchainOrder, level: 'anomaly' | 'warn', why: string) => void;
  /** 구조가 필요한 자금이 있다 / 없어졌다 */
  raiseRescue: (order: OnchainOrder, utxos: Array<{ txid: string; vout: number; valueSat: number }>) => void;
  /** 분쟁 임박 알림 — **주문당 한 번** */
  notifyDisputeSoon: (order: OnchainOrder) => void;
  /** 이번 틱에 돌 오더들 */
  listOrders: () => OnchainOrder[];
  /** 지금 스토어에 있는 그 오더 (조회를 기다리는 사이 바뀌었는지 본다) */
  getOrder: (orderId: string) => OnchainOrder | undefined;
  /** 보증금 결제 감시 (phase 0) — 여기서 오더가 생기고 클레임이 성립한다 */
  checkDeposits: () => Promise<void>;
  /**
   * 이 기기가 집행해도 되는가 (§9.1). **조회를 동반한다** — 소유권을 릴레이에서
   * 다시 읽고 답한다.
   *
   * 없으면 항상 집행한다. 테스트는 판정만 보고 싶어서 배선을 안 주는데,
   * 거기서까지 소유권을 요구하면 모든 워처 테스트가 릴레이를 흉내 내야 한다.
   * **프로덕션 배선(`runtime.ts`)은 반드시 준다.**
   */
  canAct?: () => Promise<boolean>;
}

/** 서명 요청을 다시 보내는 간격 — 고객이 폰을 바꿨거나 첫 전달이 실패했을 때 */
export const SIGNATURE_RESEND_SEC = 6 * 60 * 60;

/** 끝난 주문의 주소를 계속 보는 기간 — 늦게 들어온 펀딩·추가 입금을 잡는다 */
export const TERMINAL_WATCH_SEC = 60 * 24 * 60 * 60;

/** 끝난 주문은 드문드문 본다 (공개 mempool.space를 덜 두드린다) */
export const TERMINAL_WATCH_INTERVAL_SEC = 10 * 60;

const lastTerminalCheck = new Map<string, number>();

const EMPTY: ChainQuery<AddressFunds> = { known: true, value: { confirmed: [], mempool: [] } };

/**
 * 박아둔 outpoint에 대해 **무슨 일이 있었는지** 물어본다.
 *
 * UTXO 목록에 없을 때만 추가로 묻는다 — 누가 썼는가(`/outspend`), 썼다면 **어느 리프로**
 * (소모 증인), 안 썼다면 펀딩 tx 자체가 살아 있는가(`/tx`).
 */
export async function gatherPinnedFacts(
  order: OnchainOrder,
  funds: ChainQuery<AddressFunds>,
  chain: ChainAdapter,
): Promise<PinnedFacts | undefined> {
  const pinned = parseOutpoint(order.fundingOutpoint);
  if (!pinned) return undefined;

  const judged = judgePinnedFunding(funds, pinned, order.amountSat);
  if (judged.status !== 'missing') return judged;

  const spend = await chain.getSpend(pinned);
  if (!spend.known) return { status: 'unknown', reason: spend.reason };
  if (spend.value.spent) {
    return {
      status: 'spent',
      txid: spend.value.txid,
      confirmed: spend.value.confirmed,
      leaf: leafOfWitness(spend.value.witness, descriptorOf(order)),
    };
  }

  const funding = await chain.getTxStatus(pinned.txid);
  if (!funding.known) return { status: 'unknown', reason: funding.reason };
  if (!funding.value.seen) return { status: 'gone' };
  if (!funding.value.confirmed) {
    return { status: 'shallow', confirmations: 0, required: requiredConfirmations(order.amountSat) };
  }
  // 펀딩 tx는 블록에 있고 안 쓰였다는데 UTXO 목록엔 없다 — 인덱서가 따라잡는 중이다.
  return { status: 'unknown', reason: '펀딩 tx는 컨펌돼 있는데 UTXO 목록에 없다 (인덱서 지연?)' };
}

function descriptorOf(order: OnchainOrder) {
  return deriveEscrowAddress({
    keys: { customer: order.customerXonly!, sponsor: order.sponsorXonly!, admin: order.adminXonly! },
    network: order.network,
    timelockBlocks: order.timelockBlocks,
  });
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
  if (isOnchainTerminal(order.state)) {
    await watchFinishedAddress(order, deps);
    return { kind: 'idle' };
  }

  const funds = order.escrowAddress
    ? await deps.chain.getAddressFunds(order.escrowAddress)
    : EMPTY;

  const pinned = order.fundingOutpoint
    ? await gatherPinnedFacts(order, funds, deps.chain)
    : undefined;

  const settlementTx = order.state === 'settling' && order.settlementTxid
    ? await deps.chain.getTxStatus(order.settlementTxid)
    : undefined;

  // O-015는 `bonded`에서만 필요하다. 매 틱 LN을 찌를 이유가 없다.
  const sponsorBondAlive = order.state === 'bonded'
    ? await deps.sponsorBondAlive(order)
    : undefined;

  // 조회를 기다리는 사이 핸들러가 오더를 바꿨으면 이번 틱은 쉰다 — 다음 틱에 새 상태로 본다.
  const fresh = deps.getOrder(order.orderId);
  if (fresh && fresh.updatedAt !== order.updatedAt) {
    return { kind: 'hold', why: '조회하는 사이 오더가 바뀌었다' };
  }

  const outbox = deps.outboxTxid(order.orderId);
  const action = decideOnchainAction(order, {
    now: deps.now(),
    funds,
    pinned,
    settlementTx,
    btcPriceKrw: deps.btcPriceKrw(),
    sponsorBondAlive,
    accountInfoSent: deps.accountInfoSent(order.orderId),
    outboxPending: outbox !== undefined && order.state !== 'settling',
    canRebroadcast: outbox !== undefined && outbox === order.settlementTxid,
  });

  await executeOnchainAction(order, action, deps);

  // ── FSM 밖의 일 (상태와 무관하게 매 틱) ──
  if (order.escrowAddress && funds.known) {
    // 약정 밖의 자금. `bonded`에서는 모양이 틀린 펀딩(anomaly) 전부가 구조 대상이고
    // — 정상 펀딩이 컨펌되는 중일 때 건드리면 안 되므로 anomaly일 때만 — 확정 뒤에는
    // 박아둔 outpoint를 뺀 나머지(추가 입금)다. 빈 목록이면 경보를 내린다.
    deps.raiseRescue(order, order.state === 'bonded'
      ? (action.kind === 'anomaly' ? strayUtxos(funds, null) : [])
      : strayUtxos(funds, parseOutpoint(order.fundingOutpoint)));
  }
  await maybeResendSignature(order, deps);
  return action;
}

export async function executeOnchainAction(
  order: OnchainOrder,
  action: OnchainAction,
  deps: OnchainWatcherDeps,
): Promise<void> {
  const now = deps.now();
  const guard: TransitionGuard = { ifUnchangedSince: order.updatedAt };

  switch (action.kind) {
    case 'idle':
    case 'hold':
      // 조용히 넘긴다. 매 틱 로그를 남기면 진짜 문제가 묻힌다.
      return;

    case 'anomaly':
      deps.raise(order, 'anomaly', action.why);
      return;

    case 'warn':
      deps.raise(order, 'warn', action.why);
      return;

    case 'dispute-soon':
      deps.notifyDisputeSoon(order);
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
        // 클레임 때 경계를 보므로(policy) 여기 오면 기록이 깨진 것이다.
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
      }, guard);
      return;
    }

    case 'fold':
      // 가격을 고정하지 **않고** `bonded → refunding` (O-015 / reserve).
      await deps.decideSettlement(order, action.settlementKind, {
        fold: { outpoint: action.outpoint, confirmations: action.confirmations },
      });
      return;

    case 'cancel': {
      // 사유가 곧 보증금 처리다 — `listed`면 무과실(환불), `bonded`면 고객 몰수.
      const outcome: OnchainOutcome = order.state === 'listed'
        ? (order.expiration > 0 && now >= order.expiration ? 'cancel:expired' : 'cancel:customer')
        : 'cancel:no-funding';

      const updated = await deps.commit(order.orderId, { state: 'cancelled' }, guard);
      if (updated) deps.onOutcome(updated, outcome);
      return;
    }

    case 'reorg': {
      // **가격 고정을 폐기하고** `bonded`로 돌아간다 (O-008).
      // 마감을 다시 찍지 않으면 체인 사고로 정직한 고객이 몰수된다(§4.1c).
      const updated = await deps.commit(order.orderId, {
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
        accountDisputedAt: undefined,
      }, guard);
      if (updated) {
        deps.raise(order, 'warn', `리오그로 펀딩 확정이 풀렸다 (${action.why}) — 마감을 다시 찍었다`);
      }
      return;
    }

    case 'settle':
      await deps.decideSettlement(order, action.settlementKind);
      return;

    case 'dispute':
      // **고객 동의를 묻지 않는다** (O-010). 침묵으로 타임락까지 끄는 경로를 막는다.
      await deps.commit(order.orderId, { state: 'disputed', disputedAt: now }, guard);
      return;

    case 'confirmed': {
      const kind = order.settlementKind;
      if (!kind) {
        deps.raise(order, 'anomaly', '종결이 컨펌됐는데 사유가 없다');
        return;
      }
      const terminal = OUTCOME_RULES[kind].terminal;
      const updated = await deps.commit(order.orderId, { state: terminal }, guard);
      // 보증금은 대개 결정 때 이미 처리됐다(멱등). 릴리스는 여기서 처음 처리된다.
      if (updated) deps.onOutcome(updated, kind);
      return;
    }

    case 'observe-spend':
      await observeSpend(order, action, deps, guard);
      return;

    case 'rebroadcast':
      await deps.rebroadcast(order);
      return;

    case 'flush-outbox':
      await deps.flushOutbox(order);
      return;
  }
}

/**
 * 에스크로가 **장부에 없는 tx로** 소모됐다. 체인이 진실이다 — 장부가 따라간다.
 *
 * - **타임락 리프** → `swept`. 어드민이 부재한 사이 고객이 혼자 뺐다(O-006: 증거가 있을 때만)
 * - **릴리스 리프** → 고객·후원자가 합의해 직접 뿌렸다. 후원자가 받았으니 `release`로 적는다
 * - **결정된 사유의 리프** → 우리가 뿌린 것인데 기록이 안 남았다(기기 이전 등). 그 사유로 적는다
 * - 그 밖 → 사람이 본다. `{A,…}` 리프를 우리가 모르게 썼다면 어드민 키가 샌 것이다
 */
async function observeSpend(
  order: OnchainOrder,
  action: Extract<OnchainAction, { kind: 'observe-spend' }>,
  deps: OnchainWatcherDeps,
  guard: TransitionGuard,
): Promise<void> {
  const now = deps.now();
  const { txid, leaf } = action;

  if (leaf === 'timelock') {
    const updated = await deps.commit(order.orderId, { state: 'swept', settlementTxid: txid }, guard);
    if (updated) {
      deps.onOutcome(updated, 'swept');
      deps.raise(order, 'warn', `타임락으로 고객이 에스크로를 회수했다 (${txid})`);
    }
    return;
  }

  const decidedLeaf = order.settlementKind
    ? settlementLeafFor(settlementPathForKind(order.settlementKind))
    : undefined;
  const adopted: SettlementKind | null = leaf === 'release'
    ? 'release'
    : leaf !== null && leaf === decidedLeaf ? order.settlementKind! : null;

  if (!adopted) {
    deps.raise(
      order, 'anomaly',
      `에스크로가 장부에 없는 tx로 소모됐다 (${txid}, 리프=${leaf ?? '모름'}) — 어드민 키 유출을 의심할 것`,
    );
    return;
  }

  const patch: OnchainPatch = order.state === 'settling'
    ? { settlementKind: adopted, settlementTxid: txid }
    : { state: 'settling', settlementKind: adopted, settlementTxid: txid, settlingAt: now };
  const updated = await deps.commit(order.orderId, patch, guard);
  if (!updated) {
    deps.raise(order, 'anomaly', `체인에 뜬 종결(${txid})을 장부에 옮기지 못했다 (${order.state})`);
  }
}

/** 결정된 종결의 서명이 오래 안 오면 요청을 다시 보낸다 (첫 전달 실패·기기 교체 대비) */
async function maybeResendSignature(order: OnchainOrder, deps: OnchainWatcherDeps): Promise<void> {
  const awaiting = order.state === 'refunding'
    || (order.state === 'disputed' && order.settlementKind !== undefined);
  if (!awaiting) return;
  const last = deps.lastSignatureRequestAt(order.orderId);
  if (last !== undefined && deps.now() - last < SIGNATURE_RESEND_SEC) return;
  await deps.requestSignature(order);
}

/**
 * 끝난 주문의 주소를 한동안 계속 본다.
 *
 * 플랜은 처음부터 이걸 요구했다(§4.1c · §7.4 — "워처는 취소된 주문의 주소도 한동안
 * 계속 봐야 한다") — 멤풀에 있던 펀딩이 취소 직후 컨펌되면 **아무도 안 보는 주소에
 * 자금이 남는다.** 전에는 터미널이면 바로 빠져서 그 자금이 영영 안 보였다(리뷰 #8).
 */
async function watchFinishedAddress(order: OnchainOrder, deps: OnchainWatcherDeps): Promise<void> {
  if (!order.escrowAddress) return;
  const now = deps.now();
  if (now - order.updatedAt > TERMINAL_WATCH_SEC) return;
  const last = lastTerminalCheck.get(order.orderId);
  if (last !== undefined && now - last < TERMINAL_WATCH_INTERVAL_SEC) return;
  lastTerminalCheck.set(order.orderId, now);

  const funds = await deps.chain.getAddressFunds(order.escrowAddress);
  if (!funds.known) return;
  deps.raiseRescue(order, strayUtxos(funds, null));
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
      // **소유권 먼저.** 두 기기가 같이 돌면 `listed → bonded`가 서로 다른
      // 후원자로 두 번 일어나고, 에스크로 주소가 둘 생긴다 (§9.1).
      if (deps.canAct) {
        let allowed = false;
        try {
          allowed = await deps.canAct();
        } catch (e) {
          // 모르면 안 한다. 옛 판정으로 계속 도는 게 분단의 양쪽이 다 도는 경로다.
          console.warn('[OnchainWatcher] 소유권 확인 실패 — 이번 틱은 쉰다', e);
        }
        if (!allowed) return;
      }

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

/** @testing-only */
export function _resetWatcherForTesting(): void {
  lastTerminalCheck.clear();
}
