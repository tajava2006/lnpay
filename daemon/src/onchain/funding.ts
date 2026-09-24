/**
 * 펀딩 판정 — 체인 사실 → FSM 결정 (PLAN-ONCHAIN-TRACK §4.1c · §7 D·E·K)
 *
 * 순수 함수만 둔다. I/O는 `chain.ts`가 하고 여기서는 **받은 사실로 뭐라고
 * 말할지**만 정한다 — 돈이 걸린 판정이라 네트워크 없이 전수 테스트가 되어야 한다.
 *
 * ── 판정 규칙 (§4.1c)
 *
 * ```
 * 마감 안에, 이 주소에, 약정 금액이, N컨펌 됐는가?
 * ```
 *
 * 멤풀은 보지 않는다. 0-conf는 되돌려질 수 있고(공격 D), 그래서 FSM에
 * `funding` 상태를 두지 않았다. `pending`을 돌려주긴 하지만 그건 **화면 힌트**
 * 전용이고 어떤 결정도 그 값으로 갈리지 않는다.
 */
import type { AddressFunds, ChainOutpoint, ChainQuery } from '@sajwo-tracker/shared/onchain';
import { requiredConfirmations } from '@sajwo-tracker/shared/onchain';

/** 금액별 요구 컨펌 수 (§12 Q1) — 후원자 앱도 같은 값을 봐야 해서 shared에 있다 */
export { requiredConfirmations } from '@sajwo-tracker/shared/onchain';

export type FundingVerdict =
  /** 조회 실패 — **"없다"가 아니다.** 아무 결정도 내리지 않는다 */
  | { status: 'unknown'; reason: string }
  /** 주소가 비었다. 컨펌도 멤풀도 없다 */
  | { status: 'none' }
  /** 멤풀에만 보인다 — **화면 힌트 전용.** 판정은 `none`과 같이 취급한다 */
  | { status: 'pending'; mempoolValueSat: number }
  /** 약정 금액이 컨펌됐지만 아직 N컨펌이 아니다 */
  | { status: 'confirming'; outpoint: ChainOutpoint; confirmations: number; required: number }
  /** 됐다. 이 outpoint를 오더에 박고(`funding-outpoint`) 가격을 고정한다 */
  | { status: 'funded'; outpoint: ChainOutpoint; confirmations: number; valueSat: number }
  /**
   * 컨펌된 자금이 있는데 **모양이 약정과 다르다** (공격 K).
   *
   * UTXO가 2개 이상이거나 금액이 다른 경우다. 자동으로 진행해서도, 취소해서도
   * 안 된다 — 취소하면 그 자금이 아무도 안 보는 주소에 남는다. **사람이 봐야 한다**
   * (대개 `{A,C}` 협조 환불로 돌려주는 자리다).
   */
  | { status: 'anomaly'; reason: string; confirmedValueSat: number; utxoCount: number };

/**
 * `funded` 이전 판정. **오직 컨펌된 UTXO의 모양만** 본다.
 *
 * ⚠️ 금액은 **정확 일치**여야 한다(§6.1). 라이트닝에서 ±5% 근사를 없애고
 * `isPayoutAmountExact`로 바꾼 것과 같은 이유 — 금액을 정한 게 우리다.
 * 더 보내도 `anomaly`다: 릴리스는 UTXO를 통째로 후원자에게 보내므로 초과분이
 * 공짜로 넘어가고, 그건 고객 손해다.
 */
export function judgeFunding(
  funds: ChainQuery<AddressFunds>,
  amountSat: number,
): FundingVerdict {
  if (!funds.known) return { status: 'unknown', reason: funds.reason };

  const { confirmed, mempool } = funds.value;
  const required = requiredConfirmations(amountSat);

  if (confirmed.length === 0) {
    if (mempool.length === 0) return { status: 'none' };
    return {
      status: 'pending',
      mempoolValueSat: mempool.reduce((n, u) => n + u.valueSat, 0),
    };
  }

  const confirmedValueSat = confirmed.reduce((n, u) => n + u.valueSat, 0);

  if (confirmed.length > 1) {
    return {
      status: 'anomaly',
      reason: `컨펌된 UTXO가 ${confirmed.length}개다. 정확히 1개여야 한다`,
      confirmedValueSat,
      utxoCount: confirmed.length,
    };
  }

  const utxo = confirmed[0]!;
  if (utxo.valueSat !== amountSat) {
    return {
      status: 'anomaly',
      reason: `금액이 약정(${amountSat} sat)과 다르다: ${utxo.valueSat} sat`,
      confirmedValueSat,
      utxoCount: 1,
    };
  }

  const outpoint: ChainOutpoint = { txid: utxo.txid, vout: utxo.vout };
  if (utxo.confirmations < required) {
    return { status: 'confirming', outpoint, confirmations: utxo.confirmations, required };
  }
  return { status: 'funded', outpoint, confirmations: utxo.confirmations, valueSat: utxo.valueSat };
}

/**
 * **O-014의 입력.** "이 주소에 컨펌된 UTXO가 없는가"를 `canCancelOnchain()`이
 * 먹을 수 있는 모양으로 바꾼다.
 *
 * - 조회 실패 → `undefined` = **모름.** 게이트가 취소를 거부한다
 * - 멤풀에만 있음 → `true`. 판정은 컨펌만 보므로 취소할 수 있다(§4.1c에서
 *   받아들인 대가 — 늦게 컨펌되면 환불 절차로 간다)
 * - 컨펌된 자금이 조금이라도 있음(`anomaly` 포함) → `false`. **절대 취소하지 않는다.**
 *   취소하면 그 돈이 아무도 안 보는 주소에 남는다
 */
export function escrowUnfundedFor(verdict: FundingVerdict): boolean | undefined {
  switch (verdict.status) {
    case 'unknown': return undefined;
    case 'none':
    case 'pending': return true;
    case 'confirming':
    case 'funded':
    case 'anomaly': return false;
  }
}

export type PinnedFundingState =
  | { status: 'unknown'; reason: string }
  /** 그대로 살아 있다 */
  | { status: 'alive'; confirmations: number }
  /** 컨펌이 N 아래로 내려갔다 — 리오그. **가격 고정을 폐기하고 `bonded`로** (O-008) */
  | { status: 'shallow'; confirmations: number; required: number }
  /**
   * UTXO 목록에 없다. **왜 없는지는 아직 모른다** — 누가 썼을 수도(우리 종결 tx 포함),
   * 펀딩 tx 자체가 사라졌을 수도 있다.
   *
   * ⚠️ 전에는 이걸 곧장 `gone`(이중지불)으로 읽었다. esplora `/utxo`는 **멤풀에서 소모된
   * 출력도 뺀다** — 우리가 방금 뿌린 환불 tx가 리오그로 오인됐고, `bonded`로 돌아가
   * 마감이 차면 **엉뚱한 쪽이 몰수**됐다(리뷰 #8). 워처가 소모 여부를 따로 물어 가른다.
   */
  | { status: 'missing' };

/**
 * `funded` 이후 감시. **박아둔 outpoint 하나만** 본다.
 *
 * 여기서 모양을 다시 판정하지 않는 이유: `funded` 뒤에 같은 주소로 돈이 더 들어와도
 * (고객이 실수로 두 번 보냈다든지) **이미 고정된 거래를 흔들면 안 된다.** 추가
 * 자금은 별도 이상 징후로 사람에게 올릴 일이지 상태를 되돌릴 일이 아니다.
 */
export function judgePinnedFunding(
  funds: ChainQuery<AddressFunds>,
  pinned: ChainOutpoint,
  amountSat: number,
): PinnedFundingState {
  if (!funds.known) return { status: 'unknown', reason: funds.reason };

  const required = requiredConfirmations(amountSat);
  const match = (u: ChainOutpoint) => u.txid === pinned.txid && u.vout === pinned.vout;

  const confirmed = funds.value.confirmed.find(match);
  if (confirmed) {
    return confirmed.confirmations >= required
      ? { status: 'alive', confirmations: confirmed.confirmations }
      : { status: 'shallow', confirmations: confirmed.confirmations, required };
  }

  // 멤풀로 내려갔다 = 컨펌 0 = 리오그. 다시 캐지면 그대로 살아난다.
  if (funds.value.mempool.some(match)) {
    return { status: 'shallow', confirmations: 0, required };
  }

  return { status: 'missing' };
}

/**
 * 약정 밖의 자금 — 구조(`rescue`) 대상.
 *
 * 박아둔 outpoint가 있으면 **그걸 뺀 나머지 전부**(확정 뒤 추가 입금), 없으면(취소됐거나
 * 종결된 주문, 금액이 틀린 펀딩) **컨펌된 전부**다. 전에는 이런 자금을 볼 곳도
 * 돌려줄 길도 없어서 8주 타임락이 유일한 출구였다(리뷰 #8).
 */
export function strayUtxos(
  funds: ChainQuery<AddressFunds>,
  pinned: ChainOutpoint | null,
): Array<{ txid: string; vout: number; valueSat: number }> {
  if (!funds.known) return [];
  return funds.value.confirmed
    .filter(u => !pinned || u.txid !== pinned.txid || u.vout !== pinned.vout)
    .map(u => ({ txid: u.txid, vout: u.vout, valueSat: u.valueSat }));
}
