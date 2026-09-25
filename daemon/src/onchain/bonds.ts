/**
 * 온체인 보증금 — LN 홀드 인보이스
 *
 * ── 사유가 곧 처리다 (`applyOutcome`)
 *
 * `OUTCOME_RULES` 표를 **그대로 집행**하고 자기 판단을 하지 않는다.
 *
 * | 처리 | 뜻 | 동작 |
 * |---|---|---|
 * | `refund` | 돌려준다 | cancel — HTLC 실패라 라우팅 수수료 0 |
 * | `forfeit` | 가져간다 | settle (프리이미지는 시드에서) |
 * | `expired` | 손댈 게 없다 | LN CLTV 만료로 이미/저절로 환불된다 |
 * | `none` | 그 보증금이 없다 | 후원자가 안 붙은 단계 |
 * | `hold` | 아직 손대지 않는다 | 계좌 이의 — 사람이 과실을 가른 뒤 사유가 바뀌며 집행된다 |
 *
 * **결정 시점**에 부른다 — 종결 tx 컨펌 때가 아니다. 컨펌 때 몰수하면 몰수당할 쪽이 서명을 미뤄
 * HTLC 만료를 기다릴 수 있다. 몇 번 불려도 된다 — 받은(`accepted`) 보증금만 건드리고, 정리 효과는 인보이스당
 * 하나만 쌓인다.
 *
 * ── 결제 감시 (`createOcBondHooks`)
 *
 * 고객 보증금이 잡히면 **의뢰가 생기고**(`listed`), 후원자 보증금이 잡히면 **클레임이 성립한다**(`bonded`,
 * 세 키 확정 → 에스크로 주소). 후원자는 여럿이 동시에 인보이스를 받을 수 있고 **먼저 결제한 쪽**이 가져간다
 * 진 쪽은 취소(HTLC 실패라 수수료 0).
 */
import {
  OUTCOME_RULES, forfeitUse, fundingDeadlineFrom,
  type BondDisposition, type OnchainOrder, type OnchainOutcome,
} from '@sajwo-tracker/shared/onchain';
import { raiseAlert } from '../admin/alerts';
import { nowSec } from '../admin/context';
import type { HoldHooks, HoldPurpose, HoldRow } from '../hold';
import type { OcContext } from './context';
import { adminXonlyOf, escrowDescriptorFor } from './escrow';
import { sendOcDepositRequired, sendOcDepositStatus, sendOcRejected } from './messages';
import { notifyOcTransition } from './notify';
import {
  candidatesOf, deleteCandidate, getCandidate, getOc, insertOc, requestOcDetail, updateOc, type OcCandidate,
} from './store';

export const OC_BOND_PURPOSES = ['oc-customer-bond', 'oc-sponsor-bond'] as const satisfies readonly HoldPurpose[];

/** 블록 하나를 몇 초로 보나 — 보증금 만료 **추정**에만 쓴다 */
const BLOCK_SEC = 600;

export function applyOutcome(ctx: OcContext, order: OnchainOrder, outcome: OnchainOutcome): void {
  const rule = OUTCOME_RULES[outcome];
  applyBond(ctx, order.customerDepositHash, rule.customerBond);
  applyBond(ctx, order.sponsorDepositHash, rule.sponsorBond);

  // 몰수금의 쓰임은 운영자가 손으로 한다 — 자동화하면 "인보이스 발행 대기"라는 상태가 하나 더 생긴다
  const use = forfeitUse(outcome);
  if (use) {
    raiseAlert(ctx, {
      dedup: `oc:${order.orderId}:forfeit:${outcome}`, level: 'warn', track: 'onchain', orderId: order.orderId,
      message: `보증금 몰수(${OUTCOME_RULES[outcome].label}) — ${use === 'arbitration-fee' ? '중재료' : '50% 피해자 충당(재량)'} 처리가 필요하다`,
    });
  }
}

function applyBond(ctx: OcContext, paymentHash: string | undefined, disposition: BondDisposition): void {
  if (!paymentHash || disposition === 'none' || disposition === 'expired' || disposition === 'hold') return;
  // **받은 것만 건드린다.** 이미 정리됐거나 만료된 것을 다시 건드리면 남의 돈을 두 번 처리하려 든다
  if (ctx.holds.get(paymentHash)?.status !== 'accepted') return;
  ctx.holds.dispose(paymentHash, disposition === 'forfeit' ? 'settle' : 'cancel');
}

/** 결제를 기다리는 후원자 후보를 전부 치운다 (클레임 성립·의뢰 취소·만료) */
export function dropSponsorCandidates(ctx: OcContext, orderId: string, except?: string): void {
  for (const c of candidatesOf(ctx, orderId)) {
    if (c.type !== 'sponsor' || c.paymentHash === except) continue;
    ctx.holds.dispose(c.paymentHash, 'cancel');
    deleteCandidate(ctx, c.paymentHash);
  }
}

export function createOcBondHooks(ctx: OcContext): HoldHooks {
  return {
    created(inv) {
      const cand = getCandidate(ctx, inv.payment_hash);
      const order = getOc(ctx, inv.order_id)?.order;
      const stillWanted = cand && (cand.type === 'customer' ? !order : order?.state === 'listed');
      if (!stillWanted) {
        ctx.holds.dispose(inv.payment_hash, 'cancel');
        deleteCandidate(ctx, inv.payment_hash);
        return;
      }
      sendOcDepositRequired(ctx, inv.order_id, inv.party, inv.bolt11, inv.pay_by, inv.payment_hash);
    },

    createFailed(inv) {
      deleteCandidate(ctx, inv.payment_hash);
      sendOcRejected(ctx, inv.order_id, inv.party, '보증금 인보이스를 만들지 못했습니다. 잠시 후 다시 시도해 주세요', `hold:${inv.payment_hash}`);
    },

    accepted(inv) {
      const cand = getCandidate(ctx, inv.payment_hash);
      if (!cand) {
        // 의뢰에 붙은 보증금이 아니다(이미 처리됐거나 모르는 것) — 오더의 보증금이면 그대로 둔다
        const order = getOc(ctx, inv.order_id)?.order;
        if (order?.customerDepositHash !== inv.payment_hash && order?.sponsorDepositHash !== inv.payment_hash) {
          ctx.holds.dispose(inv.payment_hash, 'cancel');
        }
        return;
      }
      if (cand.type === 'customer') onCustomerBond(ctx, inv, cand);
      else onSponsorBond(ctx, inv, cand);
    },

    nodeCancelled(before) {
      deleteCandidate(ctx, before.payment_hash);
      // 결제 안 된 채 만료(후보가 사라진다) 또는 받은 보증금의 HTLC 만기(O-015 — 워처가 상태로 본다)
      if (before.status === 'open' || before.status === 'accepted') {
        sendOcDepositStatus(ctx, before.order_id, before.party, 'cancelled', before.payment_hash);
      }
    },

    disposed(before, final, via) {
      deleteCandidate(ctx, before.payment_hash);
      if (before.status === 'open' || before.status === 'accepted') {
        sendOcDepositStatus(ctx, before.order_id, before.party, final, before.payment_hash);
      }
      if (via === 'settle' && final === 'cancelled' && before.status === 'accepted') {
        // ⚠️ 억제 장치가 통째로 사라진 것이다 — 조용히 넘기면 아무도 모른다
        raiseAlert(ctx, {
          dedup: `oc:${before.order_id}:forfeit-missed:${before.payment_hash}`, level: 'anomaly', track: 'onchain',
          orderId: before.order_id, message: '보증금을 몰수하려 했는데 이미 취소돼 있었다(HTLC 만기) — 억제 장치가 빠졌다',
        });
      }
    },

    changed(orderId) {
      if (getOc(ctx, orderId)) requestOcDetail(ctx, orderId);
    },
  };
}

/** 고객 보증금이 잡혔다 → 의뢰가 생긴다 */
function onCustomerBond(ctx: OcContext, inv: HoldRow, cand: Extract<OcCandidate, { type: 'customer' }>): void {
  if (getOc(ctx, inv.order_id)) {
    ctx.holds.dispose(inv.payment_hash, 'cancel');
    return;
  }
  const now = nowSec(ctx);
  const { info } = cand;
  insertOc(ctx, {
    orderId: inv.order_id,
    state: 'listed',
    status: 'active',
    customerPubkey: inv.party,
    amountSat: info.amountSat,
    ...(info.reserveKrw !== undefined ? { reserveKrw: info.reserveKrw } : {}),
    createdAt: now,
    updatedAt: now,
    expiration: info.expiration,
    network: ctx.network,
    customerXonly: info.customerXonly,
    customerDepositHash: inv.payment_hash,
    raw: {},
  }, {
    refundAddress: info.refundAddress,
    customerBondExpiresAt: now + info.cltvBlocks * BLOCK_SEC,
  });
  deleteCandidate(ctx, inv.payment_hash);
  sendOcDepositStatus(ctx, inv.order_id, inv.party, 'accepted', inv.payment_hash);
  ctx.log.info('온체인 의뢰 등록', { orderId: inv.order_id });
}

/** 후원자 보증금이 잡혔다 → **클레임 성립**. 세 키가 확정되고 에스크로 주소가 나간다 */
function onSponsorBond(ctx: OcContext, inv: HoldRow, cand: Extract<OcCandidate, { type: 'sponsor' }>): void {
  const row = getOc(ctx, inv.order_id);
  if (!row || row.order.state !== 'listed') {
    // 먼저 결제한 쪽이 이미 가져갔다(또는 의뢰가 끝났다). 실패라 수수료 0
    ctx.holds.dispose(inv.payment_hash, 'cancel');
    return;
  }
  const { info } = cand;
  const adminXonly = adminXonlyOf(ctx, inv.order_id);
  const descriptor = escrowDescriptorFor({ ...row.order, sponsorXonly: info.sponsorXonly, adminXonly });
  if (!descriptor) {
    // 키가 겹치거나 형식이 틀렸다 — 이 후보로는 영영 안 된다. 돌려준다
    ctx.log.error('에스크로 주소를 만들지 못했다 — 이 보증금을 돌려준다', { orderId: inv.order_id });
    ctx.holds.dispose(inv.payment_hash, 'cancel');
    return;
  }

  const now = nowSec(ctx);
  const bonded = updateOc(ctx, inv.order_id, {
    state: 'bonded',
    sponsorPubkey: inv.party,
    sponsorXonly: info.sponsorXonly,
    adminXonly,
    escrowAddress: descriptor.address,
    timelockBlocks: descriptor.timelockBlocks,
    fundingDeadline: fundingDeadlineFrom(now),
    sponsorDepositHash: inv.payment_hash,
  }, {
    payoutAddress: info.payoutAddress,
    feerateSatPerVb: info.feerateSatPerVb,
    sponsorBondExpiresAt: now + info.cltvBlocks * BLOCK_SEC,
  });
  deleteCandidate(ctx, inv.payment_hash);
  sendOcDepositStatus(ctx, inv.order_id, inv.party, 'accepted', inv.payment_hash);
  notifyOcTransition(ctx, bonded, getOc(ctx, inv.order_id)!.version);
  dropSponsorCandidates(ctx, inv.order_id);
  ctx.log.info('온체인 클레임 성립', { orderId: inv.order_id, address: descriptor.address });
}
