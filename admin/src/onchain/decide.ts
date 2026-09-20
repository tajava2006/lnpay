/**
 * 워처의 판단 — 체인과 시계가 말하는 것 (PLAN-ONCHAIN-TRACK §9)
 *
 * **순수 함수다.** 네트워크도 시계도 여기서 만지지 않고 전부 인자로 받는다 —
 * "마감이 찼는가", "리오그가 났는가" 같은 판단은 돈이 걸린 자리라 네트워크 없이
 * 전수로 돌려볼 수 있어야 한다.
 *
 * 부르는 쪽(`watcher.ts`)은 이 함수가 돌려준 행동을 **그대로 집행**한다.
 * 여기서 안 나온 전이는 워처가 만들지 않는다.
 *
 * ── 모르면 아무것도 안 한다
 *
 * 체인 조회가 실패하면 `hold`다. '없음'이 아니라 '모름'이라서, 다음 틱에 다시
 * 묻는 게 맞다. 이걸 '없음'으로 뭉개면 **돈이 있는 주소를 비었다고 보고 취소**한다.
 */
import {
  cosignDeadlineFrom, COSIGN_GRACE_WARNING_SEC, DISPUTE_ESCALATION_SEC,
  krwDeadlineFrom, accountDeadlineFrom, presignDeadlineFrom, SETTLING_WARN_SEC,
  parseOutpoint,
  type OnchainOrder, type Outpoint, type SettlementKind,
} from '@sajwo-tracker/shared/onchain';
import type { AddressFunds, ChainQuery, TxStatus } from '@sajwo-tracker/shared/onchain';
import { judgeFunding, judgePinnedFunding, requiredConfirmations } from './funding';

export type OnchainAction =
  /** 할 일 없음 */
  | { kind: 'idle' }
  /** 모르는 게 있어 **일부러** 아무것도 안 한다. 다음 틱에 다시 본다 */
  | { kind: 'hold'; why: string }
  /** 사람이 봐야 한다 (자동 진행도 자동 취소도 위험한 자리) */
  | { kind: 'anomaly'; why: string }
  /** 상태는 그대로 두고 알림·안내만 (정체·에스컬레이션) */
  | { kind: 'warn'; why: string }
  /** `bonded → funded`. 가격을 고정한다 */
  | { kind: 'fund'; outpoint: Outpoint; confirmations: number; priceKrw: number }
  /**
   * `bonded → funded → settling`을 **한 틱에**. 가격을 고정하지 않고 접는다.
   * reserve 미달(§2.4)이거나 후원자 보증금이 이미 죽은 경우(O-015)다.
   */
  | { kind: 'fold'; outpoint: Outpoint; confirmations: number; settlementKind: SettlementKind }
  /** 마감까지 컨펌 안 됨 → `cancelled` + 고객 보증금 몰수 (§4.1c) */
  | { kind: 'cancel' }
  /** 리오그 — 가격 고정을 폐기하고 `bonded`로. **마감을 다시 찍는다** (O-008) */
  | { kind: 'reorg'; why: 'shallow' | 'gone' }
  /** 마감 초과 → 종결 tx를 만들어 `settling`으로 */
  | { kind: 'settle'; settlementKind: SettlementKind }
  /** `remitted` 마감 초과 → `disputed` 강제 전이. **고객 동의를 묻지 않는다** (O-010) */
  | { kind: 'dispute' }
  /** 종결 tx가 컨펌됐다 → 터미널 */
  | { kind: 'confirmed' };

export interface OnchainWatchContext {
  /** unix 초 */
  now: number;
  /** 에스크로 **주소** 조회 결과 (§4.1c — txid로 쫓지 않는다) */
  funds: ChainQuery<AddressFunds>;
  /** `settling`일 때 종결 tx 상태 */
  settlementTx?: ChainQuery<TxStatus>;
  /** 시세 스냅샷 (KRW/BTC). 없으면 가격을 고정할 수 없다 */
  btcPriceKrw?: number;
  /** O-015 — 후원자 보증금이 살아 있는가. `undefined`는 **모름** */
  sponsorBondAlive?: boolean;
  /** 고객이 계좌를 공개했는가 (`presigned` 안에서 주체가 갈린다) */
  accountInfoSent?: boolean;
}

export function decideOnchainAction(
  order: OnchainOrder,
  ctx: OnchainWatchContext,
): OnchainAction {
  switch (order.state) {
    case 'listed':
      // 후원자가 안 붙은 채 만료. 고객 보증금은 환불이다(무과실).
      return order.expiration > 0 && ctx.now >= order.expiration
        ? { kind: 'cancel' }
        : { kind: 'idle' };

    case 'bonded':
      return decideBonded(order, ctx);

    case 'funded':
      return decideAfterFunding(order, ctx, () =>
        ctx.now >= presignDeadlineFrom(order.fundedAt ?? 0)
          ? { kind: 'settle', settlementKind: 'refund:sponsor-timeout' }
          : { kind: 'idle' },
      );

    case 'presigned':
      return decideAfterFunding(order, ctx, () => decidePresigned(order, ctx));

    case 'remitted':
      return decideRemitted(order, ctx);

    case 'disputed':
      // **하드 마감이 없다.** 자동 해소는 어느 방향이든 탈취다(§7.5).
      // 대신 사람을 더 세게 부른다.
      return escalation(order, ctx);

    case 'settling':
      return decideSettling(order, ctx);

    default:
      // 터미널 — 관측만 한다. `swept`도 여기로 온다(O-006).
      return { kind: 'idle' };
  }
}

function decideBonded(order: OnchainOrder, ctx: OnchainWatchContext): OnchainAction {
  const verdict = judgeFunding(ctx.funds, order.amountSat);

  switch (verdict.status) {
    case 'unknown':
      return { kind: 'hold', why: `체인 조회 실패: ${verdict.reason}` };

    case 'anomaly':
      // 자동 진행도 자동 취소도 안 된다 — 취소하면 그 자금이 아무도 안 보는
      // 주소에 남는다. 대개 {A,C} 협조 환불로 돌려주는 자리다.
      return { kind: 'anomaly', why: verdict.reason };

    case 'confirming':
      return { kind: 'idle' };

    case 'none':
    case 'pending': {
      const deadline = order.fundingDeadline ?? 0;
      if (deadline > 0 && ctx.now >= deadline) return { kind: 'cancel' };
      // 멤풀에 보이는 건 **화면 힌트**일 뿐이다. 판정은 컨펌만 본다.
      return { kind: 'idle' };
    }

    case 'funded': {
      // O-015 — 보증금이 죽었으면 **무담보 옵션 창을 열지 않고 접는다.**
      if (ctx.sponsorBondAlive === false) {
        return {
          kind: 'fold',
          outpoint: verdict.outpoint,
          confirmations: verdict.confirmations,
          settlementKind: 'refund:bond-expired',
        };
      }
      if (ctx.sponsorBondAlive === undefined) {
        return { kind: 'hold', why: '후원자 보증금 생존을 모른다 (O-015)' };
      }
      if (ctx.btcPriceKrw === undefined || !(ctx.btcPriceKrw > 0)) {
        // 모르는 가격을 고정할 수는 없다. 펀딩은 이미 컨펌됐으니 다음 틱에 다시 본다.
        return { kind: 'hold', why: '시세를 모른다 — 가격을 고정할 수 없다' };
      }

      const priceKrw = Math.round((order.amountSat / 1e8) * ctx.btcPriceKrw);
      if (order.reserveKrw !== undefined && priceKrw < order.reserveKrw) {
        // 고객이 건 최저가 미만 — 아무도 과실이 없다. 양쪽 보증금 환불.
        return {
          kind: 'fold',
          outpoint: verdict.outpoint,
          confirmations: verdict.confirmations,
          settlementKind: 'refund:reserve',
        };
      }
      return { kind: 'fund', outpoint: verdict.outpoint, confirmations: verdict.confirmations, priceKrw };
    }
  }
}

/**
 * `funded` 이후 공통: **박아둔 outpoint가 살아 있는지 먼저** 본다.
 *
 * 리오그가 났는데 마감만 보고 있으면, 사라진 펀딩 위에 가격이 고정된 채로
 * 거래가 계속 굴러간다(O-008).
 */
function decideAfterFunding(
  order: OnchainOrder,
  ctx: OnchainWatchContext,
  thenDo: () => OnchainAction,
): OnchainAction {
  const pinned = parseOutpoint(order.fundingOutpoint);
  if (!pinned) return { kind: 'anomaly', why: 'funding-outpoint가 없거나 읽을 수 없다' };

  const state = judgePinnedFunding(ctx.funds, pinned, order.amountSat);
  switch (state.status) {
    case 'unknown': return { kind: 'hold', why: `체인 조회 실패: ${state.reason}` };
    case 'shallow': return { kind: 'reorg', why: 'shallow' };
    case 'gone': return { kind: 'reorg', why: 'gone' };
    case 'alive': return thenDo();
  }
}

function decidePresigned(order: OnchainOrder, ctx: OnchainWatchContext): OnchainAction {
  // 아직 계좌가 안 나갔으면 공은 **고객**에게 있다.
  if (!ctx.accountInfoSent) {
    return ctx.now >= accountDeadlineFrom(order.presignedAt ?? 0)
      ? { kind: 'settle', settlementKind: 'refund:customer-late' }
      : { kind: 'idle' };
  }

  // 계좌가 나간 뒤에는 후원자 차례다. 마감은 **계좌 공개 시점**부터 센다(O-013).
  const deadline = order.krwDeadline ?? krwDeadlineFrom(order.accountSentAt ?? 0);
  return ctx.now >= deadline
    ? { kind: 'settle', settlementKind: 'refund:sponsor-timeout' }
    : { kind: 'idle' };
}

function decideRemitted(order: OnchainOrder, ctx: OnchainWatchContext): OnchainAction {
  const deadline = cosignDeadlineFrom(order.remittedAt ?? 0);
  if (ctx.now >= deadline) return { kind: 'dispute' };
  if (ctx.now >= deadline - COSIGN_GRACE_WARNING_SEC) {
    // 유예 경고 — 느린 고객 대부분이 여기서 스스로 끝낸다(§7.5).
    return { kind: 'warn', why: '곧 분쟁으로 넘어간다 (고객 cosign 마감 임박)' };
  }
  return { kind: 'idle' };
}

function escalation(order: OnchainOrder, ctx: OnchainWatchContext): OnchainAction {
  const since = order.updatedAt;
  const [first, second] = DISPUTE_ESCALATION_SEC;
  if (ctx.now >= since + second) {
    return { kind: 'warn', why: '분쟁 14일 경과 — 이중화 경로를 호출할 것' };
  }
  if (ctx.now >= since + first) {
    return { kind: 'warn', why: '분쟁 7일 경과 — 반복 알림 + 대시보드 최상단' };
  }
  return { kind: 'idle' };
}

function decideSettling(order: OnchainOrder, ctx: OnchainWatchContext): OnchainAction {
  if (!order.settlementTxid) {
    return { kind: 'anomaly', why: 'settling인데 종결 txid가 없다' };
  }
  if (!ctx.settlementTx) return { kind: 'hold', why: '종결 tx 상태를 아직 안 물어봤다' };
  if (!ctx.settlementTx.known) {
    return { kind: 'hold', why: `종결 tx 조회 실패: ${ctx.settlementTx.reason}` };
  }

  const status = ctx.settlementTx.value;
  const required = requiredConfirmations(order.amountSat);
  if (status.confirmed && status.confirmations >= required) {
    return { kind: 'confirmed' };
  }

  // 되돌아가지 않는다(O-005). 멤풀 이탈은 **같은 tx 재브로드캐스트**로 대응하고,
  // 수수료가 모자라 안 잡히면 **받는 쪽이 CPFP**한다(릴리스는 RBF 비활성).
  const since = order.settlingAt ?? order.updatedAt;
  if (ctx.now >= since + SETTLING_WARN_SEC) {
    return { kind: 'warn', why: '종결 tx가 24시간 넘게 안 잡힌다 — CPFP 안내' };
  }
  return { kind: 'idle' };
}

/** 이 행동이 `settling`으로 가는 종결을 뜻하는가 (호출부가 tx를 만들어야 한다) */
export function needsSettlementTx(action: OnchainAction): action is
  | { kind: 'settle'; settlementKind: SettlementKind }
  | { kind: 'fold'; outpoint: Outpoint; confirmations: number; settlementKind: SettlementKind } {
  return action.kind === 'settle' || action.kind === 'fold';
}
