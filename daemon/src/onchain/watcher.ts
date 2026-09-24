/**
 * 온체인 워처 (PLAN-ONCHAIN-TRACK §9)
 *
 * "분쟁 때만 사람이 불려 나온다"를 만드는 자리다. 체인과 시계가 진실인 전이는 전부 여기서 자동으로 돈다.
 *
 * ── 사실 모으기(네트워크)와 판단·집행(트랜잭션)을 가른다
 *
 * 1. 오더마다 체인에 묻는다 — 주소의 자금, 박아둔 펀딩의 운명, 종결 tx의 컨펌 (`gather`)
 * 2. 한 트랜잭션에서 **그 사이 오더가 안 바뀌었을 때만**(버전) `decideOnchainAction`(순수 함수)이 정한 행동을
 *    그대로 집행한다. 여기서 새 전이를 발명하지 않는다.
 *
 * 조회를 기다리는 사이 요청 핸들러가 오더를 바꿨으면 이번 틱은 쉰다 — 방금 뿌린 환불을 리오그로 읽어
 * `bonded`로 되돌린 게 프론트 시절의 그 경로였다(리뷰 #8).
 *
 * 보증금 생존(O-015)은 노드에 따로 묻지 않는다 — 홀드 인보이스 관찰이 매 틱 상태를 적어 둔다.
 * 수수료는 몇 분마다 받아 둔다(핸들러가 네트워크 없이 쓴다, `fees.ts`).
 */
import {
  FUNDING_WINDOW_SEC, OUTCOME_RULES, deriveEscrowAddress, isOnchainTerminal, leafOfWitness, parseOutpoint,
  settlementLeafFor, settlementPathForKind,
  type AddressFunds, type ChainQuery, type OnchainOrder, type OnchainOutcome, type SettlementKind, type TxStatus,
} from '@sajwo-tracker/shared/onchain';
import { raiseAlert } from '../admin/alerts';
import { nowSec } from '../admin/context';
import { CATCHUP_WARMUP_SEC } from '../ln/timing';
import { applyOutcome, dropSponsorCandidates } from './bonds';
import type { OcContext } from './context';
import { decideOnchainAction, type OnchainAction, type PinnedFacts } from './decide';
import { releaseFeeFor } from './escrow';
import { saveFees } from './fees';
import { decideSettlement, requestBroadcast, requestSettlementSignature } from './flow';
import { judgePinnedFunding, requiredConfirmations, strayUtxos } from './funding';
import { notifyOcDisputeSoon, notifyOcTransition } from './notify';
import { allOc, getOc, updateOc, updateOcMeta, type OcPatch, type OcRow, type OcUtxo } from './store';

/** 체인은 블록 단위로 움직인다 — 라이트닝 틱(15초)보다 느긋하게. 공개 mempool.space를 두드리는 빈도이기도 하다 */
export const OC_POLL_MS = 30_000;

/** 수수료 추정을 새로 받는 간격 */
const FEE_REFRESH_MS = 2 * 60_000;

/** 서명 요청을 다시 보내는 간격 — 고객이 폰을 바꿨거나 첫 전달이 실패했을 때 */
export const SIGNATURE_RESEND_SEC = 6 * 60 * 60;

/** 끝난 주문의 주소를 계속 보는 기간 — 늦게 들어온 펀딩·추가 입금을 잡는다 */
export const TERMINAL_WATCH_SEC = 60 * 24 * 60 * 60;

/** 끝난 주문은 드문드문 본다 */
export const TERMINAL_WATCH_INTERVAL_SEC = 10 * 60;

/** 시계가 정하는 행동 — 재시작 직후(워밍업)에는 미룬다. 꺼져 있던 동안 마감 안에 보낸 요청을 먼저 받는다 */
const CLOCK_ACTIONS = new Set<OnchainAction['kind']>(['cancel', 'settle', 'dispute']);

const EMPTY: ChainQuery<AddressFunds> = { known: true, value: { confirmed: [], mempool: [] } };

interface Facts {
  funds: ChainQuery<AddressFunds>;
  pinned?: PinnedFacts;
  settlementTx?: ChainQuery<TxStatus>;
}

export class OcWatcher {
  private lastPollMs = -Infinity;
  private lastFeesMs = -Infinity;
  private readonly lastTerminalCheck = new Map<string, number>();

  constructor(private readonly ctx: OcContext, private readonly pollMs = OC_POLL_MS) {}

  /**
   * 수수료 추정을 받아 둔다 — 틱의 **맨 앞**(요청 처리 전)에 부른다. 핸들러가 이 값으로 보증금·최소 거래액을
   * 계산하므로, 뜨자마자 온 의뢰가 "수수료를 모른다"로 거절되지 않게.
   */
  async refreshFees(): Promise<void> {
    const { ctx } = this;
    const nowMs = ctx.nowMs();
    if (nowMs - this.lastFeesMs < FEE_REFRESH_MS) return;
    try {
      const fees = await ctx.chain.getFeeEstimates();
      if (fees.known) {
        saveFees(ctx.db, fees.value, nowSec(ctx));
        this.lastFeesMs = nowMs;
      } else {
        ctx.log.warn('수수료 추정 실패', { reason: fees.reason });
      }
    } catch (e) {
      ctx.log.warn('수수료 추정 실패', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  async poll(): Promise<void> {
    const { ctx } = this;
    const nowMs = ctx.nowMs();
    if (nowMs - this.lastPollMs < this.pollMs) return;
    this.lastPollMs = nowMs;

    for (const row of allOc(ctx)) {
      if (!this.due(row)) continue;
      let facts: Facts;
      try {
        facts = await this.gather(row.order);
      } catch (e) {
        ctx.log.warn('체인 조회 실패', { orderId: row.order.orderId, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      ctx.db.tx(() => this.apply(row.order.orderId, row.version, facts));
    }
  }

  /** 이번 틱에 볼 오더인가 — 끝난 주문은 한동안, 드문드문 */
  private due(row: OcRow): boolean {
    const { order } = row;
    if (!isOnchainTerminal(order.state)) return true;
    if (!order.escrowAddress) return false;
    const now = nowSec(this.ctx);
    if (now - order.updatedAt > TERMINAL_WATCH_SEC) return false;
    const last = this.lastTerminalCheck.get(order.orderId);
    if (last !== undefined && now - last < TERMINAL_WATCH_INTERVAL_SEC) return false;
    this.lastTerminalCheck.set(order.orderId, now);
    return true;
  }

  /** 체인에 묻는다. 주소가 있을 때만(`listed`는 아직 없다) */
  private async gather(order: OnchainOrder): Promise<Facts> {
    const { chain } = this.ctx;
    const funds = order.escrowAddress ? await chain.getAddressFunds(order.escrowAddress) : EMPTY;
    if (isOnchainTerminal(order.state)) return { funds };
    const pinned = order.fundingOutpoint ? await gatherPinnedFacts(order, funds, this.ctx) : undefined;
    const settlementTx = order.state === 'settling' && order.settlementTxid
      ? await chain.getTxStatus(order.settlementTxid)
      : undefined;
    return { funds, ...(pinned ? { pinned } : {}), ...(settlementTx ? { settlementTx } : {}) };
  }

  /** 트랜잭션 안 — 판단하고 집행한다 */
  apply(orderId: string, version: number, facts: Facts): void {
    const { ctx } = this;
    const row = getOc(ctx, orderId);
    if (!row || row.version !== version) return; // 조회하는 사이 바뀌었다 — 다음 틱에 새 상태로 본다
    const { order, meta } = row;

    if (isOnchainTerminal(order.state)) {
      // 끝난 주문의 주소에 늦게 들어온 자금 — 멤풀의 펀딩이 취소 직후 컨펌되면 아무도 안 보는 주소에 남는다
      if (facts.funds.known) this.noteStrays(row, strayUtxos(facts.funds, null));
      return;
    }

    const now = nowSec(ctx);
    const action = decideOnchainAction(order, {
      now,
      funds: facts.funds,
      ...(facts.pinned ? { pinned: facts.pinned } : {}),
      ...(facts.settlementTx ? { settlementTx: facts.settlementTx } : {}),
      ...(ctx.price() ? { btcPriceKrw: ctx.price()! } : {}),
      ...(order.state === 'bonded' ? { sponsorBondAlive: this.sponsorBondAlive(order) } : {}),
      accountInfoSent: Boolean(order.accountSentAt),
      canRebroadcast: meta.outbox !== undefined && meta.outbox.txid === order.settlementTxid,
    });

    const warmedUp = now - ctx.startedAt >= CATCHUP_WARMUP_SEC;
    if (warmedUp || !CLOCK_ACTIONS.has(action.kind)) this.execute(row, action);

    // ── FSM 밖의 일 (상태와 무관하게) ──
    const fresh = getOc(ctx, orderId)!;
    if (fresh.order.escrowAddress && facts.funds.known && !isOnchainTerminal(fresh.order.state)) {
      // `bonded`에서는 모양이 틀린 펀딩(anomaly)만 구조 대상이다 — 정상 펀딩이 컨펌되는 중에 건드리면 안 된다.
      // 확정 뒤에는 박아둔 outpoint를 뺀 나머지(추가 입금)다
      this.noteStrays(fresh, fresh.order.state === 'bonded'
        ? (action.kind === 'anomaly' ? strayUtxos(facts.funds, null) : [])
        : strayUtxos(facts.funds, parseOutpoint(fresh.order.fundingOutpoint)));
    }
    this.maybeResendSignature(fresh);
  }

  /** O-015 — 후원자 보증금이 살아 있는가. 홀드 인보이스 관찰이 적어 둔 상태로 본다. 모르면 `undefined` */
  private sponsorBondAlive(order: OnchainOrder): boolean | undefined {
    if (!order.sponsorDepositHash) return undefined;
    const status = this.ctx.holds.get(order.sponsorDepositHash)?.status;
    if (status === 'accepted') return true;
    if (status === 'cancelled' || status === 'settled') return false;
    return undefined;
  }

  private execute(row: OcRow, action: OnchainAction): void {
    const { ctx } = this;
    const { order, meta } = row;
    const id = order.orderId;
    const now = nowSec(ctx);
    const transition = (patch: OcPatch): OnchainOrder => {
      const updated = updateOc(ctx, id, patch);
      if (patch.state && patch.state !== order.state) notifyOcTransition(ctx, updated, getOc(ctx, id)!.version);
      return updated;
    };

    switch (action.kind) {
      case 'idle':
      case 'hold':
        return; // 조용히 넘긴다. 매 틱 로그를 남기면 진짜 문제가 묻힌다

      case 'anomaly':
      case 'warn':
        raiseAlert(ctx, {
          dedup: `oc:${id}:${action.kind}:${action.why}`, level: action.kind, track: 'onchain', orderId: id,
          message: action.why,
        });
        return;

      case 'dispute-soon':
        notifyOcDisputeSoon(ctx, order);
        return;

      case 'fund': {
        const releaseFeeSat = releaseFeeFor(order, meta);
        if (releaseFeeSat === undefined) {
          // 후원자가 클레임 때 주소·feerate를 냈어야 한다 — 가격을 임의로 고정하면 안 된다
          this.alert(id, 'anomaly', '릴리스 수수료를 계산할 수 없다 (후원자 주소·feerate 없음)');
          return;
        }
        const payoutSat = order.amountSat - releaseFeeSat;
        if (payoutSat <= 0) {
          this.alert(id, 'anomaly', `수수료가 거래액을 먹는다 (fee=${releaseFeeSat})`);
          return;
        }
        transition({
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

      case 'fold':
        // 가격을 고정하지 **않고** `bonded → refunding` (O-015 / reserve)
        decideSettlement(ctx, id, action.settlementKind, { outpoint: action.outpoint, confirmations: action.confirmations });
        return;

      case 'settle':
        decideSettlement(ctx, id, action.settlementKind);
        return;

      case 'cancel': {
        // 사유가 곧 보증금 처리다 — `listed`면 무과실(환불), `bonded`면 고객 몰수
        const outcome: OnchainOutcome = order.state === 'listed'
          ? (order.expiration > 0 && now >= order.expiration ? 'cancel:expired' : 'cancel:customer')
          : 'cancel:no-funding';
        const cancelled = transition({ state: 'cancelled' });
        applyOutcome(ctx, cancelled, outcome);
        dropSponsorCandidates(ctx, id);
        return;
      }

      case 'reorg': {
        // **가격 고정을 폐기하고** `bonded`로 (O-008). 마감을 다시 찍지 않으면 체인 사고로 정직한 고객이 몰수된다
        transition({
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
        });
        this.alert(id, 'warn', `리오그로 펀딩 확정이 풀렸다 (${action.why}) — 마감을 다시 찍었다`);
        return;
      }

      case 'dispute':
        // **고객 동의를 묻지 않는다** (O-010). 침묵으로 타임락까지 끄는 경로를 막는다
        transition({ state: 'disputed', disputedAt: now });
        return;

      case 'confirmed': {
        const kind = order.settlementKind;
        if (!kind) {
          this.alert(id, 'anomaly', '종결이 컨펌됐는데 사유가 없다');
          return;
        }
        const done = transition({ state: OUTCOME_RULES[kind].terminal });
        // 보증금은 대개 결정 때 이미 처리됐다(받은 것만 건드려서 두 번째는 아무것도 안 한다). 릴리스는 여기서 처음이다
        applyOutcome(ctx, done, kind);
        return;
      }

      case 'observe-spend':
        this.observeSpend(row, action);
        return;

      case 'rebroadcast':
        if (meta.outbox) requestBroadcast(ctx, { orderId: id, txid: meta.outbox.txid });
        return;
    }
  }

  /**
   * 에스크로가 **장부에 없는 tx로** 소모됐다. 체인이 진실이다 — 장부가 따라간다.
   *
   * - 타임락 리프 → `swept`. 어드민이 부재한 사이 고객이 혼자 뺐다(O-006: 증거가 있을 때만)
   * - 릴리스 리프 → 고객·후원자가 합의해 직접 뿌렸다. 후원자가 받았으니 `release`로 적는다
   * - 결정된 사유의 리프 → 우리가 뿌린 것인데 기록이 어긋났다. 그 사유로 적는다
   * - 그 밖 → 사람이 본다. `{A,…}` 리프를 우리가 모르게 썼다면 어드민 키가 샌 것이다
   */
  private observeSpend(row: OcRow, action: Extract<OnchainAction, { kind: 'observe-spend' }>): void {
    const { ctx } = this;
    const { order } = row;
    const id = order.orderId;
    const { txid, leaf } = action;

    if (leaf === 'timelock') {
      const swept = updateOc(ctx, id, { state: 'swept', settlementTxid: txid });
      applyOutcome(ctx, swept, 'swept');
      this.alert(id, 'warn', `타임락으로 고객이 에스크로를 회수했다 (${txid})`);
      return;
    }

    const decidedLeaf = order.settlementKind ? settlementLeafFor(settlementPathForKind(order.settlementKind)) : undefined;
    const adopted: SettlementKind | null = leaf === 'release'
      ? 'release'
      : leaf !== null && leaf === decidedLeaf ? order.settlementKind! : null;
    if (!adopted) {
      this.alert(id, 'anomaly', `에스크로가 장부에 없는 tx로 소모됐다 (${txid}, 리프=${leaf ?? '모름'}) — 어드민 키 유출을 의심할 것`);
      return;
    }
    const patch: OcPatch = order.state === 'settling'
      ? { settlementKind: adopted, settlementTxid: txid }
      : { state: 'settling', settlementKind: adopted, settlementTxid: txid, settlingAt: nowSec(ctx) };
    updateOc(ctx, id, patch);
  }

  /** 약정 밖의 자금을 적고, 새로 생겼으면 사람을 부른다(구조 버튼이 운영자 상세에 뜬다) */
  private noteStrays(row: OcRow, strays: OcUtxo[]): void {
    const key = (u: OcUtxo) => `${u.txid}:${u.vout}`;
    const before = new Set((row.meta.strays ?? []).map(key));
    const same = strays.length === before.size && strays.every(u => before.has(key(u)));
    if (same) return;
    updateOcMeta(this.ctx, row.order.orderId, { strays });
    const fresh = strays.filter(u => !before.has(key(u)));
    if (fresh.length > 0) {
      this.alert(row.order.orderId, 'warn',
        `약정 밖의 자금 ${fresh.length}건 (${fresh.map(u => `${u.valueSat} sat`).join(', ')}) — 고객에게 구조해 돌려줘야 한다`,
        fresh.map(key).join(','));
    }
  }

  /** 결정된 종결의 서명이 오래 안 오면 요청을 다시 보낸다 (첫 전달 실패·기기 교체 대비) */
  private maybeResendSignature(row: OcRow): void {
    const { order, meta } = row;
    const awaiting = order.state === 'refunding' || (order.state === 'disputed' && order.settlementKind !== undefined);
    if (!awaiting) return;
    if (meta.lastSignRequestAt !== undefined && nowSec(this.ctx) - meta.lastSignRequestAt < SIGNATURE_RESEND_SEC) return;
    requestSettlementSignature(this.ctx, order.orderId);
  }

  private alert(orderId: string, level: 'anomaly' | 'warn', message: string, key = message): void {
    raiseAlert(this.ctx, { dedup: `oc:${orderId}:${level}:${key}`, level, track: 'onchain', orderId, message });
  }
}

/**
 * 박아둔 outpoint에 대해 **무슨 일이 있었는지** 물어본다.
 *
 * UTXO 목록에 없을 때만 추가로 묻는다 — 누가 썼는가(`/outspend`), 썼다면 **어느 리프로**(소모 증인),
 * 안 썼다면 펀딩 tx 자체가 살아 있는가(`/tx`). "UTXO가 없다" ≠ 리오그(리뷰 #8).
 */
export async function gatherPinnedFacts(
  order: OnchainOrder,
  funds: ChainQuery<AddressFunds>,
  ctx: Pick<OcContext, 'chain'>,
): Promise<PinnedFacts | undefined> {
  const pinned = parseOutpoint(order.fundingOutpoint);
  if (!pinned) return undefined;

  const judged = judgePinnedFunding(funds, pinned, order.amountSat);
  if (judged.status !== 'missing') return judged;

  const spend = await ctx.chain.getSpend(pinned);
  if (!spend.known) return { status: 'unknown', reason: spend.reason };
  if (spend.value.spent) {
    return {
      status: 'spent',
      txid: spend.value.txid,
      confirmed: spend.value.confirmed,
      leaf: leafOfWitness(spend.value.witness, deriveEscrowAddress({
        keys: { customer: order.customerXonly!, sponsor: order.sponsorXonly!, admin: order.adminXonly! },
        network: order.network,
        timelockBlocks: order.timelockBlocks,
      })),
    };
  }

  const funding = await ctx.chain.getTxStatus(pinned.txid);
  if (!funding.known) return { status: 'unknown', reason: funding.reason };
  if (!funding.value.seen) return { status: 'gone' };
  if (!funding.value.confirmed) {
    return { status: 'shallow', confirmations: 0, required: requiredConfirmations(order.amountSat) };
  }
  // 펀딩 tx는 블록에 있고 안 쓰였다는데 UTXO 목록엔 없다 — 인덱서가 따라잡는 중이다
  return { status: 'unknown', reason: '펀딩 tx는 컨펌돼 있는데 UTXO 목록에 없다 (인덱서 지연?)' };
}
