/**
 * 온체인 종결 — 결정 · 장부 · 브로드캐스트 · 구조
 *
 * 요청을 받는 쪽은 `handlers.ts`, 체인이 미는 쪽은 `watcher.ts`다(라이트닝의 handlers/flow와 같은 나눔).
 * 여기는 워처·운영자 명령·핸들러가 같이 부르는 결정과 집행 의도다. 규칙은 docs/ONCHAIN-TRACK.md.
 *
 * - **트랜잭션 안에서, 네트워크 없이** 판단한다. 수수료는 워처가 받아 둔 값(`fees.ts`), 브로드캐스트는 효과다.
 * - **어드민 키는 시드 파생**이다(DM-005).
 * - **outbox와 `settling`을 한 트랜잭션에 쓴다**(O-019). 장부가 먼저 알고, 뿌리는 건 그 뒤의 효과다.
 * - **결정은 상태다**(O-017). 환불이 결정되면 `refunding` — 늦은 사전서명·계좌·송금 주장은 전부 거절된다.
 */
import {
  awaitingSignerFor, buildSettlementTx, formatOutpoint, isOnchainTerminal, isRefundKind, parseOutpoint,
  settlementFeeSat, signPurposeFor, toPsbtBase64, type OnchainOrder, type Outpoint, type SettlementKind,
} from '@sajwo-tracker/shared/onchain';
import { raiseAlert } from '../admin/alerts';
import { nowSec } from '../admin/context';
import { applyOutcome } from './bonds';
import type { OcContext } from './context';
import { escrowDescriptorFor, refundDestinationFor, settlementParamsFor } from './escrow';
import { currentFees } from './fees';
import { sendOcSignRequest } from './messages';
import { notifyOcRuling, notifyOcTransition } from './notify';
import { getOc, updateOc, updateOcMeta, type OcPatch, type OcRow, type OcUtxo } from './store';

export const OC_BROADCAST_EFFECT = 'oc.broadcast';

export interface BroadcastPayload {
  orderId: string;
  txid: string;
  /** 구조 tx면 `txid:vout` (meta.rescues의 키) */
  rescueKey?: string;
}

export function anomaly(ctx: OcContext, orderId: string, message: string): void {
  raiseAlert(ctx, { dedup: `oc:${orderId}:anomaly:${message}`, level: 'anomaly', track: 'onchain', orderId, message });
}

// ── 장부 → 브로드캐스트 ───────────────────────────────────────────────

/**
 * 종결 tx를 **장부에 먼저** 적고(outbox + `settling`) 뿌리는 건 효과가 한다. 같은 트랜잭션이라 "뿌렸는데
 * 장부에 없다"가 없다 — 프론트 시절 그게 리오그로 오인돼 엉뚱한 쪽이 몰수됐다.
 */
export function enterSettling(ctx: OcContext, orderId: string, kind: SettlementKind, txid: string, rawHex: string): void {
  const settling = updateOc(ctx, orderId, {
    state: 'settling', settlementKind: kind, settlementTxid: txid, settlingAt: nowSec(ctx),
  }, { outbox: { txid, rawHex, kind } });
  // 릴리스는 **고객 서명이 온 이 순간** 결정된 것이다(2026-09-25). 보관한 후원자 사전서명과 합쳐 tx가 완성됐고,
  // 에스크로를 다른 길로 뺄 수 있는 건 어드민 서명이 필요한 경로(우리가 안 한다)와 8주 타임락뿐이다 — 되돌릴
  // 수 없다. 보증금이 막을 이탈이 더는 없으니 컨펌을 기다리지 않고 지금 돌려준다(다른 사유는 원래 결정 때 처리)
  if (kind === 'release') applyOutcome(ctx, settling, kind);
  requestBroadcast(ctx, { orderId, txid });
}

export function requestBroadcast(ctx: OcContext, payload: BroadcastPayload): void {
  ctx.effects.enqueue<BroadcastPayload>(OC_BROADCAST_EFFECT, payload, { dedup: `oc.broadcast:${payload.txid}` });
}

/** 릴리스 PSBT(후원자 사전서명)를 고객에게 다시 보낸다 — 운영자 명령 */
export function resendRelease(ctx: OcContext, row: OcRow): boolean {
  if (!row.meta.presigPsbt) return false;
  sendOcSignRequest(ctx, row.order.orderId, row.order.customerPubkey, 'release', row.meta.presigPsbt);
  return true;
}

// ── 종결 결정 (워처·운영자 판정) ─────────────────────────────────────────

export type DecideError = 'bad-state' | 'no-fees' | 'no-material' | 'cannot-build';

/**
 * 종결을 **결정**한다 — 사유와 수수료를 오더에 박고, 보증금을 처리하고, 서명을 요청한다.
 *
 * - 환불(`refund:*`) → `refunding`. `fold`면 `bonded`에서 바로 간다(가격을 고정하지 않고 접는다)
 * - 분쟁 판정(`sponsor_win`·`customer_win`) → 상태는 `disputed` 그대로, 판정이 박힌다
 *
 * **보증금은 여기서 처리한다**. 결정은 **되돌리지 않는다.**
 */
export function decideSettlement(
  ctx: OcContext,
  orderId: string,
  kind: SettlementKind,
  fold?: { outpoint: Outpoint; confirmations: number },
): { ok: true; order: OnchainOrder } | { ok: false; error: DecideError } {
  const row = getOc(ctx, orderId);
  if (!row) return { ok: false, error: 'bad-state' };
  const { order, meta } = row;

  const ruling = kind === 'sponsor_win' || kind === 'customer_win';
  if (ruling) {
    if (order.state !== 'disputed' || order.settlementKind) return { ok: false, error: 'bad-state' };
  } else if (isRefundKind(kind)) {
    const allowed = fold ? order.state === 'bonded' : order.state === 'funded' || order.state === 'presigned';
    if (!allowed || order.settlementKind) return { ok: false, error: 'bad-state' };
  } else {
    return { ok: false, error: 'bad-state' }; // 릴리스는 결정하는 게 아니다 — 고객이 서명해야만 나간다(O-007)
  }

  const fees = currentFees(ctx.db, nowSec(ctx));
  if (!fees) return { ok: false, error: 'no-fees' };

  const draft: OnchainOrder = fold
    ? { ...order, fundingOutpoint: formatOutpoint(fold.outpoint.txid, fold.outpoint.vout) }
    : order;
  const shape = settlementParamsFor(draft, meta, kind, 0);
  if (!shape) {
    anomaly(ctx, orderId, `종결 재료가 없다 (${kind})`);
    return { ok: false, error: 'no-material' };
  }
  let feeSat: number;
  try {
    // ⚠️ **수수료를 새로 추정한다.** `releaseFeeSat`은 T0에 고정된 값이라 분쟁이 몇 주 뒤에 끝나면 낡는다.
    // 다만 후원자승은 후원자가 받는 출력에서 수수료가 나가고 **후원자가 정한 수수료율**이 있다 — 그보다 낮추지
    // 않는다(시세가 더 높으면 시세). 5 sat/vB로 냈는데 판정 경로만 1 sat/vB로 나갔다(2026-09-25 signet 드릴)
    const feerate = kind === 'sponsor_win' ? Math.max(meta.feerateSatPerVb ?? 0, fees.halfHour) : fees.halfHour;
    feeSat = settlementFeeSat(shape.path, shape.descriptor, shape.destination, feerate);
    buildSettlementTx({ ...shape, feeSat }); // dust 등 — 만들 수 있는 tx인지 지금 확인한다
  } catch (e) {
    anomaly(ctx, orderId, `종결 tx를 만들 수 없다 (${kind}): ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, error: 'cannot-build' };
  }

  const patch: OcPatch = {
    settlementKind: kind,
    settlementFeeSat: feeSat,
    decidedAt: nowSec(ctx),
    ...(ruling ? {} : { state: 'refunding' as const }),
    ...(fold ? { fundingOutpoint: draft.fundingOutpoint, fundingConfs: fold.confirmations } : {}),
  };
  const updated = updateOc(ctx, orderId, patch);
  applyOutcome(ctx, updated, kind);
  // 판정은 상태가 안 바뀌어 전이 알림이 없다 — 이긴 쪽이 서명해야 집행되므로 따로 알린다
  if (ruling) notifyOcRuling(ctx, updated);
  else notifyOcTransition(ctx, updated, getOc(ctx, orderId)!.version);
  requestSettlementSignature(ctx, orderId);
  ctx.log.info('온체인 종결 결정', { orderId, kind, feeSat });
  return { ok: true, order: updated };
}

/**
 * 결정된 종결의 서명을 요청한다 — **서명 없는** PSBT를 보낸다. 받는 쪽은 이걸 믿지 않고 자기 기록으로 같은
 * tx를 다시 만들어 서명한다. 여기 담긴 건 사실상 "수수료가 얼마인가" 하나다.
 */
export function requestSettlementSignature(ctx: OcContext, orderId: string): boolean {
  const row = getOc(ctx, orderId);
  const kind = row?.order.settlementKind;
  if (!row || !kind || kind === 'release') return false;
  const params = settlementParamsFor(row.order, row.meta, kind);
  const recipient = awaitingSignerFor(kind) === 'sponsor' ? row.order.sponsorPubkey : row.order.customerPubkey;
  if (!params || !recipient) {
    anomaly(ctx, orderId, '서명 요청을 만들 재료가 없다');
    return false;
  }
  sendOcSignRequest(ctx, orderId, recipient, signPurposeFor(kind), toPsbtBase64(buildSettlementTx(params)));
  updateOcMeta(ctx, orderId, { lastSignRequestAt: nowSec(ctx) });
  return true;
}

/**
 * 계좌 이의를 판정한다 — 잠정 사유(`refund:account-disputed`)를 확정한다. 환불 tx는 사유와 무관하게
 * 같은 모양이라 고객 서명은 그대로 유효하다. 입증책임 — 몰수를 면하려는 쪽(후원자)이 증명한다.
 */
export function resolveAccountDispute(
  ctx: OcContext, orderId: string, verdict: 'account-bad' | 'sponsor-fault',
): 'not-disputed' | 'bad-state' | null {
  const row = getOc(ctx, orderId);
  if (!row || row.order.settlementKind !== 'refund:account-disputed') return 'not-disputed';
  if (!['refunding', 'settling', 'refunded'].includes(row.order.state)) return 'bad-state';
  const kind: SettlementKind = verdict === 'account-bad' ? 'refund:customer-late' : 'refund:sponsor-timeout';
  const updated = updateOc(ctx, orderId, { settlementKind: kind });
  applyOutcome(ctx, updated, kind);
  return null;
}

// ── 구조 (약정 밖의 자금 → 고객) ────────────────────────────────────────

export function rescueKeyOf(o: { txid: string; vout: number }): string {
  return `${o.txid}:${o.vout}`;
}

/** 진행 중인 거래의 에스크로는 구조 대상이 아니다 — 그건 종결 tx가 쓴다(후원자가 송금한 뒤 돌리면 탈취다) */
export function isPinnedOfLiveTrade(order: OnchainOrder, utxo: { txid: string; vout: number }): boolean {
  const pinned = parseOutpoint(order.fundingOutpoint);
  if (!pinned || pinned.txid !== utxo.txid || pinned.vout !== utxo.vout) return false;
  return !isOnchainTerminal(order.state);
}

/**
 * 약정 밖의 자금 하나를 고객에게 돌려주는 요청을 보낸다 — 금액이 틀린 펀딩, 이중 송금, 취소 뒤
 * 늦게 컨펌된 펀딩, 확정 뒤 추가 입금. `{A,C}` 리프로 **고객이 낸 환불 주소**에 보낸다.
 * @returns 거절 사유. 보냈으면 `null`
 */
export function requestRescue(ctx: OcContext, orderId: string, utxo: OcUtxo): string | null {
  const row = getOc(ctx, orderId);
  if (!row) return 'unknown-order';
  const { order, meta } = row;
  if (isPinnedOfLiveTrade(order, utxo)) return 'live-escrow';
  const descriptor = escrowDescriptorFor(order);
  const destination = refundDestinationFor(order, meta);
  if (!descriptor || !destination) return 'no-material';
  const fees = currentFees(ctx.db, nowSec(ctx));
  if (!fees) return 'no-fees';

  let psbt: string;
  let feeSat: number;
  try {
    feeSat = settlementFeeSat('refund', descriptor, destination, fees.halfHour);
    psbt = toPsbtBase64(buildSettlementTx({
      descriptor, input: { outpoint: utxo, valueSat: utxo.valueSat }, path: 'refund', destination, feeSat,
    }));
  } catch {
    return 'cannot-build';
  }
  const rescues = { ...meta.rescues, [rescueKeyOf(utxo)]: { ...utxo, feeSat, destination, createdAt: nowSec(ctx) } };
  updateOcMeta(ctx, orderId, { rescues });
  sendOcSignRequest(ctx, orderId, order.customerPubkey, 'rescue', psbt);
  return null;
}
