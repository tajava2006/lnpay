/**
 * 온체인 효과 실행기 — 공개 오더 발행, 운영자 상세, 브로드캐스트
 *
 * 전부 멱등하다: 오더·상세는 발행하는 순간의 DB로 만들고(주소형이라 최신 한 장만 남는다), 브로드캐스트는
 * 같은 바이트를 다시 뿌린다(노드가 이미 알면 "already"를 돌려준다 — 성공으로 친다).
 */
import { finalizeEvent } from 'nostr-tools/pure';
import {
  ADMIN_STATE_KIND, ORDER_KIND, adminOrderDTag, nip44Encrypt, type AdminOcOrderDetail,
} from '@sajwo-tracker/shared/core';
import {
  isOnchainTerminal, onchainOrderEventExpiration, onchainOrderIssues, onchainOrderTags,
} from '@sajwo-tracker/shared/onchain';
import { raiseAlert } from '../admin/alerts';
import { nowSec } from '../admin/context';
import type { EffectExecutor } from '../effects';
import type { RelayTransport } from '../nostr/transport';
import { OC_BOND_PURPOSES } from './bonds';
import type { OcContext } from './context';
import type { BroadcastPayload } from './flow';
import { candidatesOf, getOc, updateOcMeta, type OcRow } from './store';

interface OrderPayload { orderId: string }

/** 운영자 상세의 보존 — 분쟁 기록으로 한동안 */
const DETAIL_RETENTION_SEC = 70 * 24 * 60 * 60;

// ── 공개 오더 ───────────────────────────────────────

export function createOcPublishExecutor(ctx: OcContext, transport: RelayTransport): EffectExecutor<OrderPayload> {
  return {
    async run({ orderId }) {
      const row = getOc(ctx, orderId);
      if (!row) return { status: 'done', result: {} };
      const { order } = row;
      const issues = onchainOrderIssues(order);
      if (issues.length > 0) {
        // addressable이라 덮어쓴다 — 한 번 빠진 태그는 복구되지 않는다. 막지는 않고(멈추면 더 크게 망가진다) 크게 남긴다
        ctx.log.error('온체인 오더 불변조건 위반 — 빈 칸이 있는 채로 발행한다', { orderId, state: order.state, issues });
      }
      // 주소형은 created_at이 같으면 id가 작은 쪽이 남는다 — 단조 증가시킨다
      const createdAt = Math.max(nowSec(ctx), row.publishedAt + 1);
      const expiration = onchainOrderEventExpiration(order.state, order.expiration, createdAt, isOnchainTerminal(order.state));
      if (expiration <= createdAt) {
        // 만료된 의뢰(listed) — 릴레이가 받지 않는다. 곧 워처가 닫고 종결을 다시 낸다
        return { status: 'done', result: {} };
      }
      const tags = onchainOrderTags(order, ctx.tags.onchain)
        .map(t => (t[0] === 'expiration' ? ['expiration', String(expiration)] : t));
      const event = finalizeEvent({ kind: ORDER_KIND, created_at: createdAt, tags, content: '' }, ctx.appKey.secretKey);
      const report = await transport.publish(event);
      if (report.accepted.length === 0) {
        return { status: 'retry', error: report.rejected.map(r => r.reason).join('; ') || '릴레이 없음' };
      }
      return { status: 'done', result: { createdAt } };
    },
    onDone({ orderId }, result) {
      const createdAt = (result as { createdAt?: number }).createdAt;
      if (createdAt) ctx.db.run('UPDATE oc_orders SET published_at = ? WHERE order_id = ?', createdAt, orderId);
    },
  };
}

// ── 운영자 상세 (운영자별) ───────────────────────────

export function buildOcDetail(ctx: OcContext, row: OcRow): AdminOcOrderDetail {
  const { order, meta } = row;
  const { raw: _raw, ...publicOrder } = order;
  const bonds = ctx.holds.of(order.orderId, OC_BOND_PURPOSES)
    .filter(inv => inv.payment_hash === order.customerDepositHash || inv.payment_hash === order.sponsorDepositHash)
    .map(inv => ({
      role: inv.purpose === 'oc-customer-bond' ? 'customer' as const : 'sponsor' as const,
      party: inv.party,
      amountSat: inv.amount_sat,
      status: inv.status,
      payBy: inv.pay_by,
      ...(inv.htlc_expiry_height ? { htlcExpiryHeight: inv.htlc_expiry_height } : {}),
    }));
  return {
    v: 1,
    orderId: order.orderId,
    version: row.version,
    order: publicOrder,
    ...(meta.payoutAddress ? { payoutAddress: meta.payoutAddress } : {}),
    ...(meta.feerateSatPerVb ? { feerateSatPerVb: meta.feerateSatPerVb } : {}),
    ...(meta.refundAddress ? { refundAddress: meta.refundAddress } : {}),
    hasPresig: Boolean(meta.presigPsbt),
    ...(meta.accountCommitment ? { accountCommitment: meta.accountCommitment } : {}),
    ...(meta.outbox ? { outboxTxid: meta.outbox.txid } : {}),
    ...(meta.lastSignRequestAt ? { lastSignRequestAt: meta.lastSignRequestAt } : {}),
    ...(meta.customerBondExpiresAt ? { customerBondExpiresAt: meta.customerBondExpiresAt } : {}),
    ...(meta.sponsorBondExpiresAt ? { sponsorBondExpiresAt: meta.sponsorBondExpiresAt } : {}),
    bonds,
    candidates: candidatesOf(ctx, order.orderId).filter(c => c.type === 'sponsor').length,
    strays: meta.strays ?? [],
    rescues: Object.values(meta.rescues ?? {}).map(r => ({
      txid: r.txid, vout: r.vout, valueSat: r.valueSat, feeSat: r.feeSat, destination: r.destination,
      ...(r.broadcastTxid ? { broadcastTxid: r.broadcastTxid } : {}),
    })),
  };
}

export function createOcDetailExecutor(ctx: OcContext, transport: RelayTransport): EffectExecutor<OrderPayload> {
  return {
    async run({ orderId }) {
      const row = getOc(ctx, orderId);
      if (!row) return { status: 'done', result: {} };
      const last = Number(ctx.db.kvGet(`oc.detail.at:${orderId}`) ?? 0);
      const createdAt = Math.max(nowSec(ctx), last + 1);
      const content = JSON.stringify(buildOcDetail(ctx, row));
      for (const operator of ctx.operators) {
        const event = finalizeEvent({
          kind: ADMIN_STATE_KIND,
          created_at: createdAt,
          tags: [
            ['d', adminOrderDTag(ctx.tags.admin, 'onchain', orderId, operator)],
            ['p', operator],
            ['t', ctx.tags.admin],
            ['expiration', String(createdAt + DETAIL_RETENTION_SEC)],
          ],
          content: nip44Encrypt(content, ctx.appKey.secretKey, operator),
        }, ctx.appKey.secretKey);
        const report = await transport.publish(event);
        if (report.accepted.length === 0) {
          return { status: 'retry', error: report.rejected.map(r => r.reason).join('; ') || '릴레이 없음' };
        }
      }
      return { status: 'done', result: { createdAt } };
    },
    onDone({ orderId }, result) {
      const createdAt = (result as { createdAt?: number }).createdAt;
      if (createdAt) ctx.db.kvSet(`oc.detail.at:${orderId}`, String(createdAt));
    },
  };
}

// ── 브로드캐스트 ────────────────────────────────────────────

/**
 * 우리 종결 tx·구조 tx를 뿌린다. 원본은 장부에 있다(meta.outbox·meta.rescues). 실패하면 몇 번 다시 하고,
 * 그래도 안 되면 사람을 부른다 — 종결 tx는 워처가 "멤풀에 없다"를 보고 이 효과를 다시 쌓는다(O-005).
 */
export function createBroadcastExecutor(ctx: OcContext): EffectExecutor<BroadcastPayload> {
  const rawOf = ({ orderId, txid, rescueKey }: BroadcastPayload): string | undefined => {
    const meta = getOc(ctx, orderId)?.meta;
    if (rescueKey) return meta?.rescues?.[rescueKey]?.rawHex;
    return meta?.outbox?.txid === txid ? meta.outbox.rawHex : undefined;
  };
  return {
    maxAttempts: 8,
    async run(payload) {
      const raw = rawOf(payload);
      if (!raw) return { status: 'dead', error: '뿌릴 원본이 장부에 없다' };
      const sent = await ctx.chain.broadcastTx(raw);
      if (sent.known) return { status: 'done', result: {} };
      // 이미 멤풀·블록에 있다 — 우리가 원하는 결과다
      if (/already|txn-already|in block chain|known/i.test(sent.reason)) return { status: 'done', result: {} };
      return { status: 'retry', error: sent.reason };
    },
    onDone({ orderId, txid, rescueKey }) {
      ctx.log.info('온체인 브로드캐스트', { orderId, txid, rescue: Boolean(rescueKey) });
      if (!rescueKey) return;
      const meta = getOc(ctx, orderId)?.meta;
      const rescue = meta?.rescues?.[rescueKey];
      if (rescue) updateOcMeta(ctx, orderId, { rescues: { ...meta!.rescues, [rescueKey]: { ...rescue, broadcastTxid: txid } } });
    },
    onDead({ orderId, txid }, error) {
      raiseAlert(ctx, {
        dedup: `oc:${orderId}:broadcast-dead:${txid}`, level: 'anomaly', track: 'onchain', orderId,
        message: `종결 tx를 뿌리지 못했다(${txid}): ${error}`,
      });
    },
  };
}
