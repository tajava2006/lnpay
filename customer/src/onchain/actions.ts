/**
 * 내가 하는 서명들
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
  addTapScriptSig, buildKeyPathSweep, buildSettlementTx, finalizeSettlement, settlementFeeSat, signSettlement,
  toPsbtBase64, deriveEscrowAddress, parseOutpoint, presignDeadlineOf, isPast, TIMELOCK_REMIT_THRESHOLD_BLOCKS,
  type KeyPathUtxo, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { myOrderKey } from './keys';
import { getMyClaim } from './claim-store';
import type { SignCheck } from './verify';
import { nowSec } from '@sajwo-tracker/shared';

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
 * 후원자 사전서명 — **자동으로** 만든다.
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
  // 마감이 지난 사전서명은 어드민이 받지 않는다 — 보내 봐야 헛걸음이다.
  if (order.state !== 'funded' || order.settlementKind) {
    return { ok: false, reason: '사전서명을 받는 단계가 아니다' };
  }
  if (isPast(presignDeadlineOf(order), nowSec())) {
    return { ok: false, reason: '사전서명 마감이 지났다' };
  }

  const descriptor = descriptorOf(order);
  const outpoint = parseOutpoint(order.fundingOutpoint);
  if (!descriptor || !outpoint) return { ok: false, reason: '아직 입금이 확정되지 않았다' };
  if (order.releaseFeeSat === undefined) return { ok: false, reason: '릴리스 수수료가 없다' };

  // 어드민이 고정한 수수료가 **내가 낸 feerate에서 나온 값**인지 본다.
  // 다르면 내가 덜 받는다 — 부담자가 나이므로 여기서 걸러야 한다.
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
 * 최종 서명 — **검증을 통과한 재료로 tx를 다시 만들어** 내 서명을 얹는다.
 *
 * 받은 PSBT에 그대로 서명하지 않는다. 그 PSBT에 무슨 리프·무슨 주소가
 * 들었는지를 보낸 쪽 말만 믿는 셈이라서다. `checkSignRequest`가 "누구에게 얼마가
 * 어느 리프로" 가야 하는지를 내 기록으로 정했고, 그걸로 만든 tx가 받은 PSBT와
 * 바이트까지 같다는 것도 이미 확인했다. 릴리스면 검증된 후원자 서명을 옮겨 심는다.
 */
export async function buildCosignature(orderId: string, check: SignCheck): Promise<BuildResult> {
  if (!check.ok) return { ok: false, reason: check.reason };
  try {
    const tx = buildSettlementTx(check.expected);
    if (check.counterparty) {
      addTapScriptSig(tx, check.counterparty.leafScript, check.counterparty.xonly, check.counterparty.sig);
    }
    const key = await myOrderKey(orderId);
    signSettlement(tx, key.privkey);
    return { ok: true, psbt: toPsbtBase64(tx) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 타임락으로 혼자 회수하는 tx (어드민이 증발했을 때) — **완성된 raw tx**를 돌려준다.
 *
 * `utxo`는 에스크로 주소의 UTXO 하나다 — 박아둔 펀딩이 아니어도 된다(취소 뒤 늦게
 * 들어온 펀딩, 금액이 틀린 펀딩도 이 길로 나간다). CSV는 **그 UTXO의 컨펌부터** 센다.
 * `nSequence`는 빌더가 CSV 값으로 맞춘다.
 *
 * 전에는 함수만 있고 화면이 없었다 — 스크립트에 길이 있는데 앱에 버튼이
 * 없으면 유저는 못 쓴다. 이제 "비상 회수" 화면이 이걸 부른다.
 */
export async function buildTimelockSweep(
  order: OnchainOrder,
  utxo: { txid: string; vout: number; valueSat: number },
  destination: string,
  feerateSatPerVb: number,
): Promise<{ ok: true; hex: string; txid: string; feeSat: number } | { ok: false; reason: string }> {
  const descriptor = descriptorOf(order);
  if (!descriptor) return { ok: false, reason: '에스크로 정보가 없다' };

  try {
    const feeSat = settlementFeeSat('timelock', descriptor, destination, feerateSatPerVb);
    const tx = buildSettlementTx({
      descriptor,
      input: { outpoint: { txid: utxo.txid, vout: utxo.vout }, valueSat: utxo.valueSat },
      path: 'timelock',
      destination,
      feeSat,
    });
    const key = await myOrderKey(order.orderId);
    signSettlement(tx, key.privkey);
    finalizeSettlement(tx, 'timelock');
    return { ok: true, hex: tx.hex, txid: tx.id, feeSat };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 주문별 키 단일키 주소(`tr(주문별 키)`)에 있는 자금을 내 지갑으로 — **완성된 raw tx**.
 *
 * 그 전에 만든 주문의 환불은 이 주소로 왔다. 이 앱만 쓸 수 있는 주소라 꺼내는 화면이
 * 없으면 환불금은 사실상 갇혀 있다. 멤풀에 있는 출력도 받으므로 막힌 환불
 * tx를 **CPFP로 끌어올리는** 데도 쓴다.
 */
export async function buildRefundSweep(
  order: OnchainOrder,
  utxos: readonly KeyPathUtxo[],
  destination: string,
  feerateSatPerVb: number,
): Promise<{ ok: true; hex: string; txid: string; feeSat: number; outputSat: number } | { ok: false; reason: string }> {
  try {
    const key = await myOrderKey(order.orderId);
    const { tx, feeSat, outputSat } = buildKeyPathSweep({
      privkey: key.privkey, network: order.network, utxos, destination, feerateSatPerVb,
    });
    return { ok: true, hex: tx.hex, txid: tx.id, feeSat, outputSat };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ─── 타임락 안전망 (T-106) ────────────────────────────

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
 * 환불됐다. 온체인에서는 "에스크로 만료"가 "타임락 만료"로
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
    return { safeToRemit: false, reason: '입금 컨펌 수를 확인하지 못했다' };
  }

  const remainingBlocks = Math.max(0, total - fundingConfirmations);
  if (remainingBlocks < TIMELOCK_REMIT_THRESHOLD_BLOCKS) {
    return {
      remainingBlocks,
      safeToRemit: false,
      reason: `타임락이 ${remainingBlocks}블록밖에 안 남았습니다. 지금 보내면 상대방이 혼자 회수할 수 있어 위험합니다 — 보내지 마세요.`,
    };
  }
  return {
    remainingBlocks,
    safeToRemit: true,
    reason: '타임락 여유 충분',
  };
}
