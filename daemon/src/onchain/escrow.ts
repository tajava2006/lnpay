/**
 * 에스크로 재료 — 주소·종결 tx를 **우리 기록으로만** 다시 만든다
 *
 * 사유·수수료·받는 주소가 오더(+meta)에 있으므로 언제 만들어도 한 바이트까지 같은 tx가 나온다.
 * 상대가 보낸 PSBT는 **서명 바이트를 꺼내는 데만** 쓴다 — 받은 PSBT를 그대로 완성하지 않는다.
 *
 * 어드민 키는 주문마다 시드에서 파생한다(DM-005). 프론트 시절의 키 저장소·릴레이 백업·"백업이 확인돼야
 * 주소를 낸다"(공격 M)가 통째로 사라졌다 — 시드만 있으면 언제든 같은 키가 나온다.
 */
import {
  deriveEscrowAddress, deriveSingleKeyAddress, parseOutpoint, settlementFeeSat, settlementPathForKind,
  xonlyFromPrivkey,
  type BuildSettlementParams, type EscrowDescriptor, type OnchainOrder, type SettlementKind,
} from '@sajwo-tracker/shared/onchain';
import { deriveOnchainAdminKey } from '../derive';
import type { OcContext } from './context';
import type { OcMeta } from './store';

export function adminKeyOf(ctx: Pick<OcContext, 'seed'>, orderId: string): Uint8Array {
  return deriveOnchainAdminKey(ctx.seed, orderId);
}

export function adminXonlyOf(ctx: Pick<OcContext, 'seed'>, orderId: string): string {
  return xonlyFromPrivkey(adminKeyOf(ctx, orderId));
}

/** 이 주문의 에스크로 기술자. 세 키가 다 있어야 만들어진다(겹치거나 형식이 틀리면 null) */
export function escrowDescriptorFor(order: OnchainOrder): EscrowDescriptor | null {
  if (!order.customerXonly || !order.sponsorXonly || !order.adminXonly) return null;
  try {
    return deriveEscrowAddress({
      keys: { customer: order.customerXonly, sponsor: order.sponsorXonly, admin: order.adminXonly },
      network: order.network,
      timelockBlocks: order.timelockBlocks,
    });
  } catch {
    return null;
  }
}

/** 릴리스 수수료 — **후원자가 낸 주소·feerate로** 계산한다. 부담자가 정한다 */
export function releaseFeeFor(order: OnchainOrder, meta: OcMeta): number | undefined {
  const descriptor = escrowDescriptorFor(order);
  if (!meta.payoutAddress || !meta.feerateSatPerVb || !descriptor) return undefined;
  try {
    return settlementFeeSat('release', descriptor, meta.payoutAddress, meta.feerateSatPerVb);
  } catch {
    return undefined;
  }
}

/**
 * 환불·고객승·구조가 가는 주소 — 고객이 의뢰 때 낸 **자기 지갑 주소**. 없으면 주문별 고객 키의
 * 단일키 주소(그 전에 만든 주문 — 고객 앱의 "환불금 보내기"로 꺼낸다).
 */
export function refundDestinationFor(order: OnchainOrder, meta: OcMeta): string | undefined {
  if (meta.refundAddress) return meta.refundAddress;
  return order.customerXonly ? deriveSingleKeyAddress(order.customerXonly, order.network) : undefined;
}

/** 이 사유로 정해진 종결 tx의 재료 */
export function settlementParamsFor(
  order: OnchainOrder,
  meta: OcMeta,
  kind: SettlementKind | undefined = order.settlementKind,
  feeSat: number | undefined = order.settlementFeeSat,
): BuildSettlementParams | null {
  const descriptor = escrowDescriptorFor(order);
  const outpoint = parseOutpoint(order.fundingOutpoint);
  if (!descriptor || !outpoint || !kind) return null;

  const path = settlementPathForKind(kind);
  const destination = kind === 'release' || kind === 'sponsor_win' ? meta.payoutAddress : refundDestinationFor(order, meta);
  const fee = kind === 'release' ? order.releaseFeeSat : feeSat;
  if (!destination || fee === undefined) return null;
  return { descriptor, input: { outpoint, valueSat: order.amountSat }, path, destination, feeSat: fee };
}
