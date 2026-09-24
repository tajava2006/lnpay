/**
 * 워처의 판단 — 체인과 시계가 말하는 것 (PLAN-ONCHAIN-TRACK §9)
 *
 * **순수 함수다.** 네트워크도 시계도 여기서 만지지 않고 전부 인자로 받는다 —
 * "마감이 찼는가", "리오그가 났는가" 같은 판단은 돈이 걸린 자리라 네트워크 없이
 * 전수로 돌려볼 수 있어야 한다.
 *
 * 부르는 쪽(`watcher.ts`)은 이 함수가 돌려준 행동을 **그대로 집행**한다.
 * 여기서 안 나온 전이는 워처가 만들지 않는다. (프론트 어드민에서 데몬으로 옮기며 그대로 가져왔다 —
 * 바뀐 건 outbox 마무리가 없어진 것 하나다: 데몬은 outbox와 `settling`을 한 트랜잭션에 쓴다.)
 *
 * ── 모르면 아무것도 안 한다
 *
 * 체인 조회가 실패하면 `hold`다. '없음'이 아니라 '모름'이라서, 다음 틱에 다시
 * 묻는 게 맞다. 이걸 '없음'으로 뭉개면 **돈이 있는 주소를 비었다고 보고 취소**한다.
 *
 * ── "UTXO가 없다"는 한 가지 뜻이 아니다 (리뷰 #8)
 *
 * 박아둔 펀딩이 UTXO 목록에서 빠지면 ① 누가 그걸 썼거나(우리 종결 tx 포함)
 * ② 펀딩 tx 자체가 사라졌다. 전에는 전부 ②(리오그)로 읽어서 **우리가 뿌린 환불을
 * 리오그로 오인**했다. 이제 워처가 소모 여부와 **어느 리프로 썼는지**까지 물어
 * `PinnedFacts`로 넘기고, 여기서는 그 사실대로만 말한다.
 */
import {
  cosignDeadlineFrom, COSIGN_GRACE_WARNING_SEC, DISPUTE_ESCALATION_SEC,
  accountDeadlineOf, krwDeadlineOf, presignDeadlineOf, isPast, SETTLING_WARN_SEC,
  type EscrowLeafName, type OnchainOrder, type Outpoint, type SettlementKind,
} from '@sajwo-tracker/shared/onchain';
import type { AddressFunds, ChainQuery, TxStatus } from '@sajwo-tracker/shared/onchain';
import { judgeFunding, requiredConfirmations } from './funding';

/**
 * 박아둔 펀딩 outpoint에 대해 워처가 알아낸 사실.
 *
 * - `alive` — 그대로 있다
 * - `shallow` — 컨펌이 N 아래(멤풀로 내려간 것 포함) — 리오그
 * - `gone` — 펀딩 tx 자체를 노드가 모른다 — 리오그로 사라졌거나 이중지불(공격 E)
 * - `spent` — **누가 썼다.** `leaf`는 소모 증인으로 가른 리프(모르면 `null`)
 */
export type PinnedFacts =
  | { status: 'unknown'; reason: string }
  | { status: 'alive'; confirmations: number }
  | { status: 'shallow'; confirmations: number; required: number }
  | { status: 'gone' }
  | { status: 'spent'; txid: string; leaf: EscrowLeafName | null; confirmed: boolean };

export type OnchainAction =
  /** 할 일 없음 */
  | { kind: 'idle' }
  /** 모르는 게 있어 **일부러** 아무것도 안 한다. 다음 틱에 다시 본다 */
  | { kind: 'hold'; why: string }
  /** 사람이 봐야 한다 (자동 진행도 자동 취소도 위험한 자리) */
  | { kind: 'anomaly'; why: string }
  /** 상태는 그대로 두고 알림·안내만 (정체·에스컬레이션) */
  | { kind: 'warn'; why: string }
  /** `remitted` 마감 2시간 전 — 고객에게 **한 번** 알린다 (§7.5) */
  | { kind: 'dispute-soon' }
  /** `bonded → funded`. 가격을 고정한다 */
  | { kind: 'fund'; outpoint: Outpoint; confirmations: number; priceKrw: number }
  /**
   * `bonded → refunding`. 가격을 고정하지 않고 접는다 — reserve 미달(§2.4)이거나
   * 후원자 보증금이 이미 죽은 경우(O-015)다.
   */
  | { kind: 'fold'; outpoint: Outpoint; confirmations: number; settlementKind: SettlementKind }
  /** 마감까지 컨펌 안 됨 → `cancelled` + 고객 보증금 몰수 (§4.1c) */
  | { kind: 'cancel' }
  /** 리오그 — 가격 고정을 폐기하고 `bonded`로. **마감을 다시 찍는다** (O-008) */
  | { kind: 'reorg'; why: 'shallow' | 'gone' }
  /** 마감 초과 → 환불을 **결정**한다 (`refunding`) */
  | { kind: 'settle'; settlementKind: SettlementKind }
  /** `remitted` 마감 초과 → `disputed` 강제 전이. **고객 동의를 묻지 않는다** (O-010) */
  | { kind: 'dispute' }
  /** 종결 tx가 컨펌됐다 → 터미널 */
  | { kind: 'confirmed' }
  /** 에스크로가 **우리 장부에 없는 tx로** 소모됐다 — 체인을 장부에 반영한다 */
  | { kind: 'observe-spend'; txid: string; leaf: EscrowLeafName | null; confirmed: boolean }
  /** 우리 종결 tx를 노드가 모른다(멤풀에서 쫓겨났다) — **같은 tx를 다시 뿌린다** (O-005) */
  | { kind: 'rebroadcast' };

export interface OnchainWatchContext {
  /** unix 초 */
  now: number;
  /** 에스크로 **주소** 조회 결과 (§4.1c — txid로 쫓지 않는다) */
  funds: ChainQuery<AddressFunds>;
  /** 박아둔 펀딩에 대한 사실 (펀딩 확정 이후 상태에서만) */
  pinned?: PinnedFacts;
  /** `settling`일 때 종결 tx 상태 */
  settlementTx?: ChainQuery<TxStatus>;
  /** 시세 스냅샷 (KRW/BTC). **신선한 것만** 온다. 없으면 가격을 고정할 수 없다 */
  btcPriceKrw?: number;
  /** O-015 — 후원자 보증금이 살아 있는가. `undefined`는 **모름** */
  sponsorBondAlive?: boolean;
  /** 고객이 계좌를 공개했는가 (`presigned` 안에서 주체가 갈린다) */
  accountInfoSent?: boolean;
  /** outbox의 raw tx가 지금 `settlementTxid`의 것인가 (다시 뿌릴 수 있는가) */
  canRebroadcast?: boolean;
}

/** 펀딩 확정 이후 — 박아둔 outpoint를 보는 상태들 */
const PINNED_STATES = new Set(['funded', 'presigned', 'remitted', 'disputed', 'refunding', 'settling']);

export function decideOnchainAction(
  order: OnchainOrder,
  ctx: OnchainWatchContext,
): OnchainAction {
  if (order.state === 'listed') {
    // 후원자가 안 붙은 채 만료. 고객 보증금은 환불이다(무과실).
    return order.expiration > 0 && ctx.now >= order.expiration
      ? { kind: 'cancel' }
      : { kind: 'idle' };
  }
  if (order.state === 'bonded') return decideBonded(order, ctx);
  if (!PINNED_STATES.has(order.state)) return { kind: 'idle' }; // 터미널 — 관측만 한다

  if (!order.fundingOutpoint) {
    return { kind: 'anomaly', why: 'funding-outpoint가 없거나 읽을 수 없다' };
  }

  if (order.state === 'settling') return decideSettling(order, ctx);

  const pinned = ctx.pinned ?? { status: 'unknown', reason: '펀딩 사실을 아직 안 물어봤다' };
  switch (pinned.status) {
    case 'unknown':
      return { kind: 'hold', why: `체인 조회 실패: ${pinned.reason}` };
    case 'spent':
      return { kind: 'observe-spend', txid: pinned.txid, leaf: pinned.leaf, confirmed: pinned.confirmed };
    case 'shallow':
    case 'gone':
      // 가격을 고정한 뒤(원화가 오가기 전)만 되돌린다. 원화가 흐른 뒤에는 되돌릴 곳이
      // 없다 — 사람을 부르고, 얕은 리오그면 다시 캐지길 기다린다.
      if (order.state === 'funded' || order.state === 'presigned') {
        return { kind: 'reorg', why: pinned.status };
      }
      return pinned.status === 'gone'
        ? { kind: 'anomaly', why: '펀딩 tx가 체인에서 사라졌다 (이중지불?) — 원화가 이미 오갔을 수 있다' }
        : { kind: 'hold', why: '펀딩 컨펌이 얕아졌다 — 다시 캐지길 기다린다' };
    case 'alive':
      break;
  }

  switch (order.state) {
    case 'funded':
      return isPast(presignDeadlineOf(order), ctx.now)
        ? { kind: 'settle', settlementKind: 'refund:sponsor-timeout' }
        : { kind: 'idle' };
    case 'presigned':
      return decidePresigned(order, ctx);
    case 'remitted':
      return decideRemitted(order, ctx);
    case 'disputed':
      // **하드 마감이 없다.** 자동 해소는 어느 방향이든 탈취다(§7.5). 사람을 더 세게 부른다.
      return escalation(order, ctx);
    default:
      // refunding — 고객 서명을 기다린다. 재촉은 워처가 따로 한다.
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
      // 주소에 남는다. 어드민이 **구조**(`{A,C}`로 고객에게)를 보내고, 주소가 비면
      // 마감 뒤 취소로 끝난다(고객 몰수 — 약정대로 펀딩하지 않았다).
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
        // 모르는(또는 낡은) 가격을 고정할 수는 없다. 펀딩은 컨펌됐으니 다음 틱에 다시 본다.
        return { kind: 'hold', why: '신선한 시세가 없다 — 가격을 고정할 수 없다' };
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

function decidePresigned(order: OnchainOrder, ctx: OnchainWatchContext): OnchainAction {
  // 아직 계좌가 안 나갔으면 공은 **고객**에게 있다.
  if (!ctx.accountInfoSent) {
    return isPast(accountDeadlineOf(order), ctx.now)
      ? { kind: 'settle', settlementKind: 'refund:customer-late' }
      : { kind: 'idle' };
  }

  // 계좌가 나간 뒤에는 후원자 차례다. 마감은 **계좌 공개 시점**부터 센다(O-013).
  if (!isPast(krwDeadlineOf(order), ctx.now)) return { kind: 'idle' };

  // 후원자가 마감 **전에** 계좌 이의를 냈다면 누구 과실인지 사람이 가른다(§5.2b).
  return {
    kind: 'settle',
    settlementKind: order.accountDisputedAt ? 'refund:account-disputed' : 'refund:sponsor-timeout',
  };
}

function decideRemitted(order: OnchainOrder, ctx: OnchainWatchContext): OnchainAction {
  const deadline = cosignDeadlineFrom(order.remittedAt ?? 0);
  if (ctx.now >= deadline) return { kind: 'dispute' };
  // 유예 경고 — 느린 고객 대부분이 여기서 스스로 끝낸다(§7.5). 한 번만 보낸다.
  if (ctx.now >= deadline - COSIGN_GRACE_WARNING_SEC) return { kind: 'dispute-soon' };
  return { kind: 'idle' };
}

function escalation(order: OnchainOrder, ctx: OnchainWatchContext): OnchainAction {
  // `updatedAt`은 재발행마다 바뀐다 — 분쟁 진입 시각을 따로 들고 있다.
  const since = order.disputedAt ?? order.updatedAt;
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

  // 에스크로를 **다른 tx**가 가져갔으면 그게 사실이다 — 우리 tx는 무효가 됐다.
  const pinned = ctx.pinned;
  if (pinned?.status === 'spent' && pinned.txid !== order.settlementTxid) {
    return { kind: 'observe-spend', txid: pinned.txid, leaf: pinned.leaf, confirmed: pinned.confirmed };
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

  // 되돌아가지 않는다(O-005). 멤풀에서 쫓겨났으면 **같은 tx를 다시 뿌린다.**
  if (!status.seen) {
    return ctx.canRebroadcast
      ? { kind: 'rebroadcast' }
      : { kind: 'anomaly', why: '종결 tx가 멤풀에 없고 다시 뿌릴 원본도 없다' };
  }

  // 수수료가 모자라 안 잡히면 **받는 쪽이 CPFP**한다(RBF 신호 없음).
  const since = order.settlingAt ?? order.updatedAt;
  if (ctx.now >= since + SETTLING_WARN_SEC) {
    return { kind: 'warn', why: '종결 tx가 24시간 넘게 안 잡힌다 — 받는 쪽 CPFP 안내' };
  }
  return { kind: 'idle' };
}

/** 이 행동이 환불 결정인가 (호출부가 수수료를 추정해 `refunding`을 발행해야 한다) */
export function needsSettlementDecision(action: OnchainAction): action is
  | { kind: 'settle'; settlementKind: SettlementKind }
  | { kind: 'fold'; outpoint: Outpoint; confirmations: number; settlementKind: SettlementKind } {
  return action.kind === 'settle' || action.kind === 'fold';
}
