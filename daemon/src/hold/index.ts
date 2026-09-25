/**
 * 홀드 인보이스 — 라이트닝 에스크로·보증금과 온체인 보증금이 같이 쓴다
 *
 * 인보이스 한 장의 일생은 트랙과 무관하게 같다:
 *
 * ```
 * plan ─ creating ─(hold.create)→ open ─(노드: 결제됨)→ accepted ─(hold.dispose)→ settled / cancelled
 *              └────────────────────────(기한 넘김·거래 닫힘)──────────────────→ cancelled
 * ```
 *
 * 무엇을 위한 인보이스인지(목적 = `purpose`)에 따라 **그 다음 일**만 다르다 — 트랙이 목적별로
 * `HoldHooks`를 등록하고, 여기는 멱등한 노드 호출과 상태 기록만 한다. 노드를 부르는 곳은 효과
 * 실행기뿐이고, 전부 **조회 먼저**다(재시작 뒤 다시 돌아도 같은 결과로 수렴한다).
 *
 * 프리이미지는 저장하지 않는다 — `(목적, 오더, [사람], 시도)`에서 시드로 다시 만든다(DM-005).
 */
import { raiseAlert } from '../admin/alerts';
import { nowSec, type AdminContext } from '../admin/context';
import { derivePreimage, paymentHashOf, preimageScope, type PreimagePurpose } from '../derive';
import type { EffectExecutor } from '../effects';
import type { HoldLookup, LnNode } from '../ln/lnd';

export const HOLD_CREATE_EFFECT = 'hold.create';
export const HOLD_DISPOSE_EFFECT = 'hold.dispose';

export type HoldPurpose = PreimagePurpose;
export type HoldStatus = 'creating' | 'open' | 'accepted' | 'settled' | 'cancelled';
export type HoldFinal = 'settled' | 'cancelled';

/** 한 장의 기록 — 테이블 이름(`ln_invoices`)은 라이트닝 인보이스라는 뜻이다(온체인 보증금도 LN이다) */
export interface HoldRow {
  payment_hash: string;
  purpose: HoldPurpose;
  order_id: string;
  /** 내는 사람 */
  party: string;
  attempt: number;
  amount_sat: number;
  /** 만들어지기 전엔 빈 문자열 */
  bolt11: string;
  pay_by: number;
  cltv_blocks: number;
  status: HoldStatus;
  htlc_expiry_height: number | null;
  created_at: number;
  updated_at: number;
}

/** 아직 끝나지 않은 인보이스 */
export const LIVE_HOLD_STATUSES: readonly HoldStatus[] = ['creating', 'open', 'accepted'];

export function isLiveHold(inv: Pick<HoldRow, 'status'>): boolean {
  return LIVE_HOLD_STATUSES.includes(inv.status);
}

/**
 * 목적별 후속 처리. 전부 **트랜잭션 안에서, 네트워크 없이** 불린다 — 효과를 쌓을 뿐이다.
 * 인자로 받는 행은 **바뀌기 전** 모습이다(`nodeCancelled`·`disposed`에서 "유저가 본 적 있나"를 가른다).
 */
export interface HoldHooks {
  /** 노드가 만들었다 (`open`) — 유저에게 전할 자리 */
  created(inv: HoldRow): void;
  /** 결제 기한 안에 노드가 못 만들었다 (노드가 오래 꺼져 있었다) — 이미 `cancelled`로 적혔다 */
  createFailed(inv: HoldRow): void;
  /** 유저가 결제했다 (HTLC가 잡혔다) — 이미 `accepted`로 적혔다 */
  accepted(inv: HoldRow): void;
  /** 노드가 스스로 취소했다 (결제 기한 만료, HTLC 만기 직전) — 이미 `cancelled`로 적혔다 */
  nodeCancelled(before: HoldRow): void;
  /**
   * 우리가 정리했다. `via`는 누가 했나 — `settle`·`cancel`은 `dispose()`, `batch`는 트랙의 묶음 효과
   * (라이트닝 닫기처럼 여러 장을 한 번에 정리하는 것).
   */
  disposed(before: HoldRow, final: HoldFinal, via: 'settle' | 'cancel' | 'batch'): void;
  /** 인보이스 상태가 바뀌었다 — 운영자 상세를 다시 낼 자리 */
  changed(orderId: string): void;
  /** 트랙의 묶음 효과가 이 인보이스를 다루는 중인가 — 그러면 관찰 결과를 거기 맡긴다 */
  busy?(inv: HoldRow): boolean;
}

export interface HoldContext extends AdminContext {
  node: LnNode;
  seed: Uint8Array;
}

interface CreatePayload { paymentHash: string }
interface DisposePayload { paymentHash: string; action: 'settle' | 'cancel' }

export class Holds {
  private readonly hooks = new Map<HoldPurpose, HoldHooks>();

  constructor(private readonly ctx: HoldContext) {}

  register(purposes: readonly HoldPurpose[], hooks: HoldHooks): void {
    for (const p of purposes) {
      if (this.hooks.has(p)) throw new Error(`홀드 목적 중복 등록: ${p}`);
      this.hooks.set(p, hooks);
    }
  }

  private hooksFor(purpose: HoldPurpose): HoldHooks {
    const h = this.hooks.get(purpose);
    if (!h) throw new Error(`등록되지 않은 홀드 목적: ${purpose}`);
    return h;
  }

  // ── 읽기 ────────────────────────────────────────────────

  get(paymentHash: string): HoldRow | undefined {
    return this.ctx.db.get<HoldRow>('SELECT * FROM ln_invoices WHERE payment_hash = ?', paymentHash);
  }

  of(orderId: string, purposes?: readonly HoldPurpose[]): HoldRow[] {
    const rows = this.ctx.db.all<HoldRow>(
      'SELECT * FROM ln_invoices WHERE order_id = ? ORDER BY created_at, attempt', orderId,
    );
    return purposes ? rows.filter(r => purposes.includes(r.purpose)) : rows;
  }

  /** 이 사람의 이 오더 인보이스 중 아직 살아 있는(또는 받은) 것 */
  current(purpose: HoldPurpose, orderId: string, party: string): HoldRow | undefined {
    return this.ctx.db.get<HoldRow>(
      `SELECT * FROM ln_invoices WHERE purpose = ? AND order_id = ? AND party = ?
       AND status IN ('creating', 'open', 'accepted', 'settled') ORDER BY attempt DESC LIMIT 1`,
      purpose, orderId, party,
    );
  }

  /** 우리가 낸 인보이스의 해시인가 — 우리 인보이스를 지급처로 받으면 안 된다 */
  isOurs(paymentHash: string): boolean {
    return this.get(paymentHash) !== undefined;
  }

  // ── 쓰기 ────────────────────────────────────────────────

  /**
   * 인보이스를 **계획**한다 — 해시가 시드에서 미리 정해지므로 행을 먼저 쓰고, 노드 호출은 효과가 한다.
   * @param holdUntil HTLC가 살아 있어야 하는 시각 → CLTV
   */
  plan(p: {
    purpose: HoldPurpose; orderId: string; party: string; amountSat: number; payBy: number; cltvBlocks: number;
  }): HoldRow {
    const now = nowSec(this.ctx);
    const row = this.ctx.db.get<{ n: number | null }>(
      'SELECT MAX(attempt) AS n FROM ln_invoices WHERE purpose = ? AND order_id = ? AND party = ?',
      p.purpose, p.orderId, p.party,
    );
    const attempt = row?.n === null || row?.n === undefined ? 0 : Number(row.n) + 1;
    const hash = paymentHashOf(derivePreimage(this.ctx.seed, scopeOf(p.purpose, p.orderId, p.party), attempt));
    this.ctx.db.run(
      `INSERT INTO ln_invoices (payment_hash, purpose, order_id, party, attempt, amount_sat, bolt11, pay_by,
         cltv_blocks, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 'creating', ?, ?)`,
      hash, p.purpose, p.orderId, p.party, attempt, p.amountSat, p.payBy, p.cltvBlocks, now, now,
    );
    this.ctx.effects.enqueue<CreatePayload>(HOLD_CREATE_EFFECT, { paymentHash: hash }, { dedup: `hold:${hash}` });
    this.hooksFor(p.purpose).changed(p.orderId);
    return this.get(hash)!;
  }

  /** 정리한다 — settle(받기) 또는 cancel(돌려주기). 안 낸 인보이스는 settle을 원해도 취소된다 */
  dispose(paymentHash: string, action: 'settle' | 'cancel'): void {
    this.ctx.effects.enqueue<DisposePayload>(HOLD_DISPOSE_EFFECT, { paymentHash, action }, { dedup: `hold.dispose:${paymentHash}` });
  }

  /** 상태를 적는다 (관찰·효과 결과) */
  set(paymentHash: string, patch: Partial<Pick<HoldRow, 'status' | 'bolt11' | 'htlc_expiry_height'>>): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length === 0) return;
    this.ctx.db.run(
      `UPDATE ln_invoices SET ${[...keys.map(k => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE payment_hash = ?`,
      ...keys.map(k => patch[k] ?? null), nowSec(this.ctx), paymentHash,
    );
    const inv = this.get(paymentHash);
    if (inv) this.hooksFor(inv.purpose).changed(inv.order_id);
  }

  /**
   * 트랙의 묶음 효과가 정리한 결과를 적는다 (그 효과의 onDone에서). 이미 그 상태면 아무것도 안 한다.
   */
  recordDisposal(paymentHash: string, final: HoldFinal, via: 'settle' | 'cancel' | 'batch'): void {
    const before = this.get(paymentHash);
    if (!before || before.status === final) return;
    this.set(paymentHash, { status: final });
    this.hooksFor(before.purpose).disposed(before, final, via);
  }

  /** 시드에서 다시 만든다. 해시가 안 맞으면 파생 규칙이 틀어진 것 — 던진다 */
  preimageOf(inv: HoldRow): string {
    const preimage = derivePreimage(this.ctx.seed, scopeOf(inv.purpose, inv.order_id, inv.party), inv.attempt);
    if (paymentHashOf(preimage) !== inv.payment_hash) {
      throw new Error(`프리이미지가 해시와 맞지 않는다: ${inv.payment_hash}`);
    }
    return Buffer.from(preimage).toString('hex');
  }

  /**
   * 조회 결과를 보고 원하는 쪽으로 정리한다(노드 호출). 이미 정리됐으면 그 결과.
   * 묶음 효과(라이트닝 닫기)가 이걸로 여러 장을 차례로 정리한다.
   */
  async settleOrCancel(inv: HoldRow, want: 'settle' | 'cancel', lookup: HoldLookup | null): Promise<HoldFinal> {
    if (!lookup) return 'cancelled'; // 만들어진 적 없다
    if (lookup.state === 'settled') return 'settled';
    if (lookup.state === 'cancelled') return 'cancelled';
    if (want === 'settle' && lookup.state === 'accepted') {
      await this.ctx.node.settleInvoice(this.preimageOf(inv));
      return 'settled';
    }
    await this.ctx.node.cancelInvoice(inv.payment_hash);
    return 'cancelled';
  }

  // ── 효과 ────────────────────────────────────────────────

  install(): void {
    const { ctx } = this;
    ctx.effects.register<CreatePayload>(HOLD_CREATE_EFFECT, this.createExecutor());
    ctx.effects.register<DisposePayload>(HOLD_DISPOSE_EFFECT, this.disposeExecutor());
  }

  private createExecutor(): EffectExecutor<CreatePayload> {
    const { ctx } = this;
    return {
      run: async ({ paymentHash }) => {
        const inv = this.get(paymentHash);
        if (!inv) return { status: 'dead', error: '모르는 인보이스' };
        const existing = await ctx.node.lookupInvoice(paymentHash);

        if (inv.status !== 'creating') {
          // 만들기 전에 취소됐다. 지난 시도가 노드에 만들어 놓고 죽었으면 치운다
          if (existing && (existing.state === 'open' || existing.state === 'accepted')) {
            await ctx.node.cancelInvoice(paymentHash);
          }
          return { status: 'done', result: {} };
        }
        if (existing) return { status: 'done', result: { bolt11: existing.bolt11 } };

        const expirySec = inv.pay_by - nowSec(ctx);
        if (expirySec < 60) return { status: 'done', result: { tooLate: true } };
        const { bolt11 } = await ctx.node.addHoldInvoice({
          paymentHash, amountSat: inv.amount_sat, expirySec, cltvBlocks: inv.cltv_blocks,
          memo: `pairbuy ${inv.purpose} ${inv.order_id}`,
        });
        return { status: 'done', result: { bolt11 } };
      },
      onDone: ({ paymentHash }, result) => {
        const inv = this.get(paymentHash);
        if (!inv || inv.status !== 'creating') return; // 그 사이 취소됐다 — 실행기가 노드 쪽을 치웠다
        const r = result as { bolt11?: string; tooLate?: boolean };
        if (r.tooLate || !r.bolt11) {
          this.set(paymentHash, { status: 'cancelled' });
          ctx.log.warn('홀드 인보이스를 기한 안에 못 만들었다', { orderId: inv.order_id, purpose: inv.purpose });
          this.hooksFor(inv.purpose).createFailed(this.get(paymentHash)!);
          return;
        }
        this.set(paymentHash, { status: 'open', bolt11: r.bolt11 });
        this.hooksFor(inv.purpose).created(this.get(paymentHash)!);
      },
    };
  }

  private disposeExecutor(): EffectExecutor<DisposePayload> {
    return {
      run: async ({ paymentHash, action }) => {
        const inv = this.get(paymentHash);
        if (!inv) return { status: 'dead', error: '모르는 인보이스' };
        const lookup = await this.ctx.node.lookupInvoice(paymentHash);
        return { status: 'done', result: { final: await this.settleOrCancel(inv, action, lookup) } };
      },
      onDone: ({ paymentHash, action }, result) => {
        this.recordDisposal(paymentHash, (result as { final: HoldFinal }).final, action);
      },
    };
  }

  // ── 관찰 (틱마다) ───────────────────────────────────────

  /** 살아 있는 인보이스를 노드에 묻고, 바뀐 만큼 목적별 후속 처리를 부른다 */
  async poll(): Promise<void> {
    const live = this.ctx.db.all<{ payment_hash: string; order_id: string }>(
      `SELECT payment_hash, order_id FROM ln_invoices WHERE status IN ('open', 'accepted') ORDER BY created_at`,
    );
    for (const { payment_hash: hash, order_id: orderId } of live) {
      let lookup: HoldLookup | null;
      try {
        lookup = await this.ctx.node.lookupInvoice(hash);
      } catch (e) {
        this.ctx.log.warn('인보이스 조회 실패', { orderId, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      this.ctx.db.tx(() => this.observe(hash, lookup));
    }
  }

  observe(paymentHash: string, lookup: HoldLookup | null): void {
    const { ctx } = this;
    const inv = this.get(paymentHash);
    if (!inv || (inv.status !== 'open' && inv.status !== 'accepted')) return;
    const hooks = this.hooksFor(inv.purpose);
    // 정리 효과가 돌고 있으면 그쪽이 결과를 적는다 — 여기서 같이 적으면 "우리가 안 한 settle"로 오인한다
    if (this.disposing(inv) || hooks.busy?.(inv)) return;
    const track = inv.purpose.startsWith('oc-') ? 'onchain' as const : 'ln' as const;

    if (!lookup) {
      raiseAlert(ctx, {
        dedup: `hold:missing:${paymentHash}`, level: 'anomaly', track, orderId: inv.order_id,
        message: `노드에 인보이스가 없다(${inv.purpose}) — LND 데이터가 바뀌었는지 확인해야 한다`,
      });
      return;
    }
    if (lookup.htlcExpiryHeight && lookup.htlcExpiryHeight !== inv.htlc_expiry_height) {
      this.set(paymentHash, { htlc_expiry_height: lookup.htlcExpiryHeight });
    }

    if (lookup.state === 'accepted' && inv.status === 'open') {
      this.set(paymentHash, { status: 'accepted' });
      hooks.accepted(this.get(paymentHash)!);
      return;
    }
    if (lookup.state === 'settled') {
      this.set(paymentHash, { status: 'settled' });
      raiseAlert(ctx, {
        dedup: `hold:unexpected-settle:${paymentHash}`, level: 'anomaly', track, orderId: inv.order_id,
        message: `데몬이 하지 않은 settle(${inv.purpose}) — 프리이미지가 밖에 있는지 확인해야 한다`,
      });
      return;
    }
    if (lookup.state === 'cancelled') {
      this.set(paymentHash, { status: 'cancelled' });
      hooks.nodeCancelled(inv);
    }
  }

  private disposing(inv: HoldRow): boolean {
    return this.ctx.db.get(
      `SELECT 1 FROM effects WHERE status = 'pending' AND dedup = ?`, `hold.dispose:${inv.payment_hash}`,
    ) !== undefined;
  }
}

function scopeOf(purpose: HoldPurpose, orderId: string, party: string): string {
  // 후원자 보증금만 사람을 넣는다 — 한 주문에 후보가 여럿일 수 있다(클레임했다 풀린 후원자, 온체인 동시 클레임)
  const perParty = purpose === 'ln-sponsor-deposit' || purpose === 'oc-sponsor-bond';
  return preimageScope(purpose, orderId, perParty ? party : undefined);
}
