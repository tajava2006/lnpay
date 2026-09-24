/**
 * 온체인 보증금 처리 (PLAN-ONCHAIN-TRACK §4.1 · §6.0)
 *
 * **사유가 곧 처리다.** 전이만 보고 판단하면 어드민이 정반대로 처리한다 —
 * `refunded` 하나에 보증금 처리가 반대인 사례가 섞여 있다. 그래서 이 파일은
 * `OUTCOME_RULES` 표를 **그대로 집행**하고, 자기 판단을 하지 않는다.
 *
 * | 처리 | 뜻 | 동작 |
 * |---|---|---|
 * | `refund` | 돌려준다 | `cancelInvoice` — HTLC 실패라 **라우팅 수수료 0** |
 * | `forfeit` | 가져간다 | `settleInvoice(preimage)` |
 * | `expired` | 손댈 게 없다 | LN CLTV 만료로 이미/저절로 환불된다 |
 * | `none` | 그 보증금이 없다 | 후원자가 안 붙은 단계 |
 * | `hold` | 아직 손대지 않는다 | 계좌 이의 — 사람이 과실을 가른 뒤 사유가 바뀌며 집행된다 |
 *
 * ── 언제 부르나 (리뷰 #8)
 *
 * **결정 시점**이다 — `refunding` 진입, 분쟁 판정, 계좌 이의 판정, 취소. 종결 tx
 * 컨펌 때가 아니다. 환불 tx는 고객 서명이 있어야 나가는데, 컨펌 때 몰수하면
 * `refund:customer-late`처럼 **몰수당할 쪽이 그 시점을 쥔다** — HTLC가 만료될 때까지
 * 서명을 미루면 몰수가 사라진다. 터미널에서 한 번 더 불리지만 **멱등**이다
 * (`accepted`가 아니면 손대지 않는다).
 *
 * ⚠️ 몰수한 돈의 쓰임은 여기서 안 정한다 — 분쟁이면 중재료, 타임아웃이면
 * 50% 피해자 충당이고 **둘 다 운영자가 손으로 한다**(§6.0). 자동화하면
 * "인보이스 발행 대기"라는 상태가 FSM에 하나 더 생긴다.
 */
import {
  OUTCOME_RULES, forfeitUse, onchainMessageExpiration,
  type BondDisposition, type OnchainOrder, type OnchainOutcome,
} from '@sajwo-tracker/shared/onchain';
import type { LightningAdapter } from '../lightning';
import { getPreimage } from '../escrow-store';
import { getEscrowMeta } from './escrow-meta-store';
import { publishOnchainDepositStatus } from './publish';

export async function handleOnchainOutcome(
  order: OnchainOrder,
  outcome: OnchainOutcome,
  lnAdapter: LightningAdapter | null,
): Promise<void> {
  if (!lnAdapter) return;
  const rule = OUTCOME_RULES[outcome];
  const meta = getEscrowMeta(order.orderId);

  await applyBond({
    lnAdapter,
    order,
    who: 'customer',
    pubkey: order.customerPubkey,
    paymentHash: order.customerDepositHash,
    escrowKey: meta?.customerDepositKey,
    disposition: rule.customerBond,
  });

  await applyBond({
    lnAdapter,
    order,
    who: 'sponsor',
    pubkey: order.sponsorPubkey,
    paymentHash: order.sponsorDepositHash,
    escrowKey: meta?.sponsorDepositKey,
    disposition: rule.sponsorBond,
  });

  const use = forfeitUse(outcome);
  if (use) {
    // 운영자가 손으로 할 일이 생겼다는 신호다. 대시보드가 이걸 집는다(P5).
    console.log(
      '[Onchain] 몰수금 처리 필요:', order.orderId, outcome,
      use === 'arbitration-fee' ? '→ 중재료' : '→ 50% 피해자 충당(재량)',
    );
  }
}

async function applyBond(params: {
  lnAdapter: LightningAdapter;
  order: OnchainOrder;
  who: 'customer' | 'sponsor';
  pubkey?: string;
  paymentHash?: string;
  escrowKey?: string;
  disposition: BondDisposition;
}): Promise<void> {
  const { lnAdapter, order, who, pubkey, paymentHash, escrowKey, disposition } = params;
  if (disposition === 'none' || disposition === 'expired' || disposition === 'hold') return;
  if (!paymentHash) return;

  try {
    // **accepted가 아니면 손대지 않는다.** 이미 정산됐거나 환불된 것을 다시
    // 건드리면 에러만 나고, 최악의 경우 남의 돈을 두 번 처리하려 든다.
    const status = await lnAdapter.lookupHoldInvoice(paymentHash);
    if (status !== 'accepted') return;

    if (disposition === 'refund') {
      await lnAdapter.cancelInvoice(paymentHash);
      if (pubkey) {
        notifyBond(order.orderId, pubkey, 'cancelled');
      }
      console.log('[Onchain] 보증금 환불', who, order.orderId);
      return;
    }

    // forfeit
    const preimage = escrowKey ? getPreimage(escrowKey) : null;
    if (!preimage) {
      // ⚠️ 프리이미지가 없으면 몰수할 수 없다. **조용히 넘기면 안 된다** —
      // 억제 장치가 통째로 사라진 것이고, 그 사실을 아무도 모른다.
      console.error('[Onchain] 몰수 불가 — 프리이미지가 없다:', who, order.orderId, escrowKey);
      return;
    }
    await lnAdapter.settleInvoice(preimage);
    if (pubkey) {
      notifyBond(order.orderId, pubkey, 'settled');
    }
    console.log('[Onchain] 보증금 몰수', who, order.orderId);
  } catch (e) {
    console.error('[Onchain] 보증금 처리 실패', who, order.orderId, e);
  }
}

/**
 * 보증금 처리 통지.
 *
 * ⚠️ 만료를 **의뢰 만료로 두면 안 된다** — 보증금은 거래가 끝날 때 처리되고, 그때는
 * 의뢰 만료가 한참 지났다. 릴레이가 NIP-40으로 거절해 통지가 한 번도 안 나갔다
 * (리뷰 #8 — e2e 릴레이가 만료를 거절하게 바꾸자 드러났다).
 */
function notifyBond(orderId: string, pubkey: string, status: 'cancelled' | 'settled'): void {
  void publishOnchainDepositStatus(orderId, pubkey, status, onchainMessageExpiration(Math.floor(Date.now() / 1000)))
    .catch(e => console.warn('[Onchain] 보증금 통지 실패', orderId, e));
}
