/**
 * 온체인 저장소 — `oc_orders`·`oc_candidates` (마이그레이션 v4)
 *
 * 오더는 shared `OnchainOrder`를 그대로 JSON으로 둔다 — 필드가 많고 공개 이벤트 코덱(`onchainOrderTags`)이
 * 그 타입을 먹는다. 공개하지 않는 값(후원자의 받을 주소, 사전서명, 환불 주소, outbox, 구조 기록)은 `meta`다.
 *
 * **오더를 바꾸는 길은 `updateOc` 하나다.** 전이를 FSM으로 확인하고, 버전을 올리고(DM-006), 공개 발행과
 * 운영자 상세를 같이 쌓는다.
 */
import {
  canOnchainTransition, isOnchainTerminal,
  type OnchainOrder, type SettlementKind,
} from '@sajwo-tracker/shared/onchain';
import { nowSec } from '../admin/context';
import type { OcContext } from './context';

export const OC_ORDER_PUBLISH_EFFECT = 'oc.order.publish';
export const OC_DETAIL_EFFECT = 'oc.detail';

export interface OcUtxo {
  txid: string;
  vout: number;
  valueSat: number;
}

/** 구조(`rescue`) — 약정 밖 자금 하나를 고객에게 돌려주는 `{A,C}` tx */
export interface OcRescue extends OcUtxo {
  /** 고객에게 보여준 그 tx의 수수료 — 서명을 검증할 때 같은 tx를 다시 만든다 */
  feeSat: number;
  destination: string;
  createdAt: number;
  /** 완성한 tx (브로드캐스트 재시도용) */
  rawHex?: string;
  /** 브로드캐스트가 받아들여졌으면 그 txid */
  broadcastTxid?: string;
}

export interface OcMeta {
  /** 후원자가 받을 주소 (후원자가 정한다). **실제 지갑 주소**라 공개하지 않는다 */
  payoutAddress?: string;
  /** 릴리스 tx에 쓸 feerate (sat/vB). 부담자(후원자)가 정한다 */
  feerateSatPerVb?: number;
  /** 우리가 검증한 후원자 사전서명 PSBT (base64) — 릴리스를 완성할 때 쓴다 */
  presigPsbt?: string;
  /** 고객이 의뢰 때 낸 환불 받을 주소 — 환불·고객승·구조가 여기로 간다 */
  refundAddress?: string;
  /** 고객이 계좌를 보낼 때 단 솔티드 커밋먼트 — 계좌 이의 판정 때 후원자가 공개한 것과 대조한다 */
  accountCommitment?: string;
  /** 보증금 HTLC가 만료될 것으로 **추정**되는 시각 — 판정이 이걸 넘기면 몰수할 게 없다 */
  customerBondExpiresAt?: number;
  sponsorBondExpiresAt?: number;
  /** 우리 종결 tx (브로드캐스트 전에 적는다 — 멤풀에서 쫓겨나면 같은 바이트를 다시 뿌린다, O-005) */
  outbox?: { txid: string; rawHex: string; kind: SettlementKind };
  /** 마지막으로 서명 요청을 보낸 시각 (재촉 간격) */
  lastSignRequestAt?: number;
  /** 약정 밖의 자금 — 마지막으로 본 것 */
  strays?: OcUtxo[];
  /** 구조 요청 — 키는 `txid:vout` */
  rescues?: Record<string, OcRescue>;
}

export interface OcRow {
  order: OnchainOrder;
  meta: OcMeta;
  version: number;
  publishedAt: number;
}

/** `updateOc`가 바꿀 수 있는 칸. **`undefined`는 지운다**(리오그로 가격 고정을 폐기할 때) */
export type OcPatch = Partial<Omit<OnchainOrder, 'orderId' | 'raw' | 'createdAt' | 'updatedAt' | 'status'>>;

interface RawRow {
  order_id: string;
  data: string;
  meta: string;
  version: number;
  published_at: number;
}

function fromRaw(r: RawRow): OcRow {
  return {
    order: { ...(JSON.parse(r.data) as Omit<OnchainOrder, 'raw'>), raw: {} },
    meta: JSON.parse(r.meta) as OcMeta,
    version: r.version,
    publishedAt: r.published_at,
  };
}

function toData(order: OnchainOrder): string {
  const { raw: _raw, ...rest } = order;
  return JSON.stringify(rest); // undefined 칸은 여기서 사라진다
}

export function getOc(ctx: Pick<OcContext, 'db'>, orderId: string): OcRow | undefined {
  const r = ctx.db.get<RawRow>('SELECT * FROM oc_orders WHERE order_id = ?', orderId);
  return r ? fromRaw(r) : undefined;
}

export function allOc(ctx: Pick<OcContext, 'db'>): OcRow[] {
  return ctx.db.all<RawRow>('SELECT * FROM oc_orders ORDER BY rowid').map(fromRaw);
}

export function insertOc(ctx: OcContext, order: OnchainOrder, meta: OcMeta): void {
  ctx.db.run(
    'INSERT INTO oc_orders (order_id, state, data, meta) VALUES (?, ?, ?, ?)',
    order.orderId, order.state, toData(order), JSON.stringify(meta),
  );
  requestProjection(ctx, order.orderId);
}

/**
 * 상태 전이 + 필드 갱신을 **한 번에** 한다 — 갈라 두면 "전이는 됐는데 그 상태가 요구하는 값이 아직 없는"
 * 순간이 생기고, 그 사이 발행이 나가면 addressable이라 태그가 빠진 채로 덮어쓴다.
 * 규칙에 안 맞는 전이는 **던진다**(트랜잭션째 되돌아간다) — 부르는 쪽이 이미 확인했어야 한다.
 */
export function updateOc(ctx: OcContext, orderId: string, patch: OcPatch, metaPatch?: Partial<OcMeta>): OnchainOrder {
  const row = getOc(ctx, orderId);
  if (!row) throw new Error(`모르는 온체인 오더: ${orderId}`);
  const to = patch.state ?? row.order.state;
  if (to !== row.order.state && !canOnchainTransition(row.order.state, to)) {
    throw new Error(`온체인 전이 불가: ${row.order.state} → ${to}`);
  }
  const order: OnchainOrder = {
    ...row.order,
    ...patch,
    state: to,
    status: isOnchainTerminal(to) ? 'sold' : 'active',
    // 같은 초에 두 번 바뀌어도 앞으로 간다 — 발행 created_at이 이걸 따른다
    updatedAt: Math.max(nowSec(ctx), row.order.updatedAt + 1),
  };
  const meta = metaPatch ? { ...row.meta, ...metaPatch } : row.meta;
  ctx.db.run(
    'UPDATE oc_orders SET state = ?, data = ?, meta = ?, version = version + 1 WHERE order_id = ?',
    to, toData(order), JSON.stringify(meta), orderId,
  );
  requestProjection(ctx, orderId);
  return order;
}

/** 비공개 칸만 바꾼다 — 버전을 올리지 않는다(서명 요청 시각 같은 것에 운영자 명령이 낡지 않게) */
export function updateOcMeta(ctx: OcContext, orderId: string, metaPatch: Partial<OcMeta>): void {
  const row = getOc(ctx, orderId);
  if (!row) return;
  ctx.db.run('UPDATE oc_orders SET meta = ? WHERE order_id = ?', JSON.stringify({ ...row.meta, ...metaPatch }), orderId);
  requestOcDetail(ctx, orderId);
}

export function requestOcDetail(ctx: OcContext, orderId: string): void {
  ctx.effects.enqueue(OC_DETAIL_EFFECT, { orderId }, { dedup: `oc.detail:${orderId}` });
}

function requestProjection(ctx: OcContext, orderId: string): void {
  ctx.effects.enqueue(OC_ORDER_PUBLISH_EFFECT, { orderId }, { dedup: `oc.order:${orderId}` });
  requestOcDetail(ctx, orderId);
}

// ── 보증금 대기 (의뢰·클레임 후보) ──────────────────────────

export interface CustomerCandidateInfo {
  amountSat: number;
  reserveKrw?: number;
  /** 의뢰 만료 */
  expiration: number;
  customerXonly: string;
  refundAddress: string;
  cltvBlocks: number;
}

export interface SponsorCandidateInfo {
  sponsorXonly: string;
  payoutAddress: string;
  feerateSatPerVb: number;
  cltvBlocks: number;
}

export type OcCandidate =
  | { paymentHash: string; orderId: string; type: 'customer'; party: string; info: CustomerCandidateInfo; createdAt: number }
  | { paymentHash: string; orderId: string; type: 'sponsor'; party: string; info: SponsorCandidateInfo; createdAt: number };

interface RawCandidate {
  payment_hash: string;
  order_id: string;
  type: 'customer' | 'sponsor';
  party: string;
  info: string;
  created_at: number;
}

function candidateFromRaw(r: RawCandidate): OcCandidate {
  return {
    paymentHash: r.payment_hash, orderId: r.order_id, type: r.type, party: r.party,
    info: JSON.parse(r.info), createdAt: r.created_at,
  } as OcCandidate;
}

export function putCandidate(ctx: Pick<OcContext, 'db'>, c: OcCandidate): void {
  ctx.db.run(
    'INSERT INTO oc_candidates (payment_hash, order_id, type, party, info, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    c.paymentHash, c.orderId, c.type, c.party, JSON.stringify(c.info), c.createdAt,
  );
}

export function getCandidate(ctx: Pick<OcContext, 'db'>, paymentHash: string): OcCandidate | undefined {
  const r = ctx.db.get<RawCandidate>('SELECT * FROM oc_candidates WHERE payment_hash = ?', paymentHash);
  return r ? candidateFromRaw(r) : undefined;
}

export function candidatesOf(ctx: Pick<OcContext, 'db'>, orderId: string): OcCandidate[] {
  return ctx.db.all<RawCandidate>('SELECT * FROM oc_candidates WHERE order_id = ? ORDER BY created_at', orderId)
    .map(candidateFromRaw);
}

export function deleteCandidate(ctx: Pick<OcContext, 'db'>, paymentHash: string): void {
  ctx.db.run('DELETE FROM oc_candidates WHERE payment_hash = ?', paymentHash);
}
