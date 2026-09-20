/**
 * 내가 하는 서명들 (PLAN-ONCHAIN-TRACK §2.4 · §6.1b · §7.1)
 *
 * 두 가지가 여기 모여 있다:
 *   ① **후원자의 사전서명** — 사람의 판단이 필요 없다. 앱이 자동으로 한다
 *   ② **양쪽의 최종 서명** — 받은 PSBT를 확인하고 내 키를 얹는다
 *
 * ⚠️ 릴리스 최종 서명만은 **자동화하지 않는다**(O-007). 고객이 은행 입금을
 * 눈으로 확인하고 누르는 것이고, 그게 유일한 방어선이다. 여기 함수들은
 * 호출되면 서명할 뿐이고, **언제 부를지**는 화면이 정한다.
 */
import {
  buildSettlementTx, fromPsbtBase64, settlementFeeSat, signSettlement, toPsbtBase64,
  deriveEscrowAddress, parseOutpoint,
  type OnchainOrder, type SettlementPath,
} from '@sajwo-tracker/shared/onchain';
import { myOrderKey } from './keys';
import { getMyClaim } from './claim-store';

function descriptorOf(order: OnchainOrder) {
  if (!order.customerXonly || !order.sponsorXonly || !order.adminXonly) return null;
  return deriveEscrowAddress({
    keys: {
      customer: order.customerXonly,
      sponsor: order.sponsorXonly,
      admin: order.adminXonly,
    },
    network: order.network,
    timelockBlocks: order.timelockBlocks,
  });
}

export type BuildResult =
  | { ok: true; psbt: string }
  | { ok: false; reason: string };

/**
 * 후원자 사전서명 — **자동으로** 만든다 (§2.4).
 *
 * 고민할 것이 없다: 받을 주소와 feerate는 클레임 때 이미 냈고, 펀딩 txid는
 * 어드민이 확정했으며, 금액은 `amountSat − releaseFeeSat`으로 정해져 있다.
 * **15분은 앱이 깨어나는 시간이지 판단하는 시간이 아니다.**
 *
 * 그래도 **내가 다시 만들어 서명한다** — 어드민이 준 PSBT에 서명하면, 그 PSBT가
 * 내 주소로 가는지 어드민 말만 믿는 셈이 된다.
 */
export async function buildPresignature(order: OnchainOrder): Promise<BuildResult> {
  const claim = getMyClaim(order.orderId);
  if (!claim) return { ok: false, reason: '내가 낸 받을 주소를 찾을 수 없다' };

  const descriptor = descriptorOf(order);
  const outpoint = parseOutpoint(order.fundingOutpoint);
  if (!descriptor || !outpoint) return { ok: false, reason: '아직 펀딩이 확정되지 않았다' };
  if (order.releaseFeeSat === undefined) return { ok: false, reason: '릴리스 수수료가 없다' };

  // 어드민이 고정한 수수료가 **내가 낸 feerate에서 나온 값**인지 본다.
  // 다르면 내가 덜 받는다 — 부담자가 나이므로(§6.0) 여기서 걸러야 한다.
  const expected = settlementFeeSat('release', descriptor, claim.payoutAddress, claim.feerateSatPerVb);
  if (expected !== order.releaseFeeSat) {
    return {
      ok: false,
      reason: `릴리스 수수료가 내가 낸 값과 다르다 (기대 ${expected}, 오더 ${order.releaseFeeSat})`,
    };
  }

  try {
    const tx = buildSettlementTx({
      descriptor,
      input: { outpoint, valueSat: order.amountSat },
      path: 'release',
      destination: claim.payoutAddress,
      feeSat: order.releaseFeeSat,
    });
    const key = await myOrderKey(order.orderId);
    signSettlement(tx, key.privkey);
    return { ok: true, psbt: toPsbtBase64(tx) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 받은 PSBT에 내 서명을 얹는다 (최종 서명).
 *
 * **PSBT를 새로 만들지 않는다** — 상대 서명이 그 안에 들어 있어서, 다시 만들면
 * 그 서명이 날아간다. 대신 호출 전에 `inspectSettlementPsbt`로 "내 에스크로를
 * 쓰는가 / 얼마가 나가는가"를 확인한다.
 */
export async function cosignSettlement(
  orderId: string,
  psbtBase64: string,
): Promise<BuildResult> {
  try {
    const tx = fromPsbtBase64(psbtBase64);
    const key = await myOrderKey(orderId);
    signSettlement(tx, key.privkey);
    return { ok: true, psbt: toPsbtBase64(tx) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 타임락으로 혼자 회수하는 tx (어드민이 증발했을 때).
 *
 * 받는 주소는 **내 주문별 키로 만든 단일키 주소**다 — 환불과 같은 이유로
 * 물어볼 대상이 없다. `nSequence`는 빌더가 CSV 값으로 맞춘다.
 */
export async function buildTimelockSweep(
  order: OnchainOrder,
  destination: string,
  feerateSatPerVb: number,
): Promise<BuildResult> {
  const descriptor = descriptorOf(order);
  const outpoint = parseOutpoint(order.fundingOutpoint);
  if (!descriptor || !outpoint) return { ok: false, reason: '펀딩 기록이 없다' };

  try {
    const feeSat = settlementFeeSat('timelock', descriptor, destination, feerateSatPerVb);
    const tx = buildSettlementTx({
      descriptor,
      input: { outpoint, valueSat: order.amountSat },
      path: 'timelock',
      destination,
      feeSat,
    });
    const key = await myOrderKey(order.orderId);
    signSettlement(tx, key.privkey);
    return { ok: true, psbt: toPsbtBase64(tx) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 어느 리프로 서명하는지 — 화면이 사유를 보여줄 때 쓴다 */
export function pathForPurpose(
  purpose: 'release' | 'refund' | 'dispute-customer' | 'dispute-sponsor',
): SettlementPath {
  switch (purpose) {
    case 'release': return 'release';
    case 'refund': return 'refund';
    case 'dispute-customer': return 'customer-win';
    case 'dispute-sponsor': return 'sponsor-win';
  }
}

// ─── 타임락 안전망 (T-106 · §7.1) ────────────────────────────

/** 송금 차단 임계 — 잔여가 이보다 적으면 원화를 보내면 안 된다 (§6.2) */
export const TIMELOCK_BLOCK_THRESHOLD = 1008;

export interface TimelockStatus {
  /** 타임락까지 남은 블록. 모르면 `undefined` */
  remainingBlocks?: number;
  /** 원화를 보내도 되는가 */
  safeToRemit: boolean;
  reason: string;
}

/**
 * **되돌릴 수 없는 행동(원화 송금) 직전에 내 보호 창이 살아 있는지** 확인시킨다.
 *
 * 라이트닝 트랙에서 정확히 같은 모양의 버그를 겪었다 — 에스크로가 2시간 남았는데
 * 6시간짜리 인보이스를 받아줘서, 후원자가 원화를 보낸 뒤 HTLC가 타임아웃으로
 * 환불됐다(AUDIT-EXPIRY F2). 온체인에서는 "에스크로 만료"가 "타임락 만료"로
 * 바뀔 뿐 구조가 같다.
 *
 * ⚠️ **컨펌 수를 모르면 막는다.** 모르는 걸 "아직 여유 있다"로 치면 그 순간
 * 이 안전망이 없는 것과 같다.
 */
export function timelockStatus(
  order: OnchainOrder,
  fundingConfirmations: number | undefined,
): TimelockStatus {
  const total = order.timelockBlocks;
  if (!total) {
    return { safeToRemit: false, reason: '타임락 값을 아직 모른다' };
  }
  if (fundingConfirmations === undefined) {
    return { safeToRemit: false, reason: '펀딩 컨펌 수를 확인하지 못했다' };
  }

  const remainingBlocks = Math.max(0, total - fundingConfirmations);
  if (remainingBlocks < TIMELOCK_BLOCK_THRESHOLD) {
    return {
      remainingBlocks,
      safeToRemit: false,
      reason: `타임락 잔여가 ${remainingBlocks}블록뿐입니다. 지금 보내면 고객이 혼자 회수할 수 있습니다.`,
    };
  }
  return {
    remainingBlocks,
    safeToRemit: true,
    reason: `타임락 잔여 ${remainingBlocks}블록 — 보호 창이 열려 있습니다.`,
  };
}
