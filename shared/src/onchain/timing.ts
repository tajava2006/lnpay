/**
 * 온체인 트랙의 마감 시계 (PLAN-ONCHAIN-TRACK §6.2)
 *
 * **마감 없는 상태는 없다**(O-009). 예외는 `disputed` 하나뿐이고, 그건 자동
 * 해소가 어느 방향이든 탈취라서다(§7.5).
 *
 * ```
 * listed ──의뢰 만료(최대 7일)──→ cancelled
 * bonded ──2시간(컨펌까지)──────→ cancelled + 고객 몰수
 * funded ──15분──────────────────→ refund:sponsor-timeout
 *            └ presigned ──1시간(계좌 공개)──→ refund:customer-late
 *                          └ 계좌공개+30분──→ refund:sponsor-timeout
 * remitted ──24시간──────────────→ disputed (고객 동의 불필요)
 * settling ──24시간──────────────→ 경고 + CPFP 안내
 * ```
 *
 * ── 마감의 기준점이 규약이다 (O-013)
 *
 * 앞의 두 마감은 **T0(펀딩 컨펌)** 에 묶여 있고, 후원자의 송금 마감만
 * **계좌 공개 시점**을 기준으로 센다. 그래야
 *   ① 고객이 늦게 공개해도 **후원자 창이 깎이지 않고**
 *   ② 그런데도 총합이 **T0+105분을 못 넘는다** (`MAX_OPTION_WINDOW_SEC`)
 * 마감을 앞 단계에 상대적으로 걸면 후원자가 14:59에 사전서명을 내는 식으로
 * **총 창을 늘릴 수 있다** — 그래서 각 마감을 자기가 통제 못 하는 지점에 앵커한다.
 */
import { PRICE_VALIDITY_MS } from './state-machine';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 의뢰 만료 상한 — 보증금 CLTV 천장(13일)에 여유를 두고 7일 (§2.2) */
export const MAX_ORDER_EXPIRY_SEC = 7 * DAY;

/**
 * `bonded` → 펀딩 **컨펌까지** (§4.1c). 3컨펌(~30분)도 넉넉히 들어간다.
 *
 * 6시간이었다가 **2시간으로 줄였다**(2026-09-25, signet 드릴). 후원자는 보증금을 걸고 기다리는데 6시간은
 * 길었다. 블록 간격 때문에 3컨펌이 2시간을 넘길 확률은 ~0.05%다 — 실제로 걸리는 건 수수료를 낮게 잡은
 * 경우이고, 그건 RBF·CPFP로 고객이 올린다.
 */
export const FUNDING_WINDOW_SEC = 2 * HOUR;

/** T0 → 후원자 사전서명. 앱이 깨어나는 시간이지 고민할 시간이 아니다 */
export const PRESIGN_WINDOW_SEC = 15 * MINUTE;

/**
 * `presigned` → 고객이 계좌 공개.
 *
 * 5분 → 15분(2026-09-21) → **1시간**(2026-09-25, signet 드릴). 고객은 이미 본 자금을 에스크로에 넣었고,
 * 알림을 받고 앱을 열어 은행·계좌번호·예금주를 입력해야 한다 — 15분은 급했다.
 *
 * ⚠️ **대가가 있다 — 가격은 T0에 고정됐다.** 이 창 동안 시세가 오르면 고객은 계좌를 안 내고 빠지는 게
 * 이득일 수 있다(대가: 고객 보증금 1% + 온체인 수수료 2회). 피해자(후원자)는 원화를 아직 안 보냈으니 잃는
 * 건 시간뿐이다. 그리고 고객이 늦게 낼수록 후원자의 송금 마감(계좌 공개 +30분)이 뒤로 밀려 **후원자의 옵션
 * 창이 최대 105분으로 늘어난다** — 후원자 보증금 3%는 60분 꼬리로 잡은 값이다(§2.4). 다만 그 연장은 고객이
 * 늦을 때만 생기고, 후원자가 그 창으로 빠지면 수수료를 잃는 것도 늦은 그 고객이다.
 */
export const ACCOUNT_WINDOW_SEC = 1 * HOUR;

/** 계좌 공개 → 후원자 원화 송금. 한국 실시간 이체면 넉넉하다 */
export const KRW_WINDOW_SEC = 30 * MINUTE;

/** `remitted` → 고객 cosign. 자는 고객이 헛분쟁을 안 만들 정도 */
export const COSIGN_WINDOW_SEC = PRICE_VALIDITY_MS / 1000;

/** 그 마감 2시간 전 유예 경고 — 느린 고객 대부분이 여기서 스스로 끝낸다 (§7.5) */
export const COSIGN_GRACE_WARNING_SEC = 2 * HOUR;

/** `settling` 컨펌 대기. 넘으면 경고 + CPFP 안내 (하드 마감 아님) */
export const SETTLING_WARN_SEC = 24 * HOUR;

/** `disputed` 에스컬레이션 (§7.5). 하드 마감이 아니라 사람을 더 세게 부르는 시점 */
export const DISPUTE_ESCALATION_SEC = [7 * DAY, 14 * DAY] as const;

/**
 * 분쟁 진입 후 **판정에 쓸 수 있다고 보장하는 시간** (보증금 CLTV 예산의 마지막 칸).
 *
 * 몰수는 판정 **시점**에 집행된다(리뷰 #8). 그러니 보증금 HTLC는 판정이 나올 때까지만
 * 살아 있으면 된다 — 종결 tx 컨펌(`settling`)까지 덮을 필요는 없다. 대신 분쟁은
 * 하드 마감이 없으므로(§7.5) **이 시간을 넘긴 판정은 몰수를 못 할 수 있다.**
 * 어드민 화면이 보증금 만료 추정치를 보여주는 이유다.
 */
export const DISPUTE_RULING_BUDGET_SEC = 24 * HOUR;

/**
 * 온체인 이벤트가 릴레이에 남아 있어야 하는 기간.
 *
 * ⚠️ **의뢰 만료(`expiration`)를 이벤트 만료로 쓰면 안 된다**(리뷰 #8). 의뢰 만료는
 * "후원자를 찾는 창"이고, 거래는 그 뒤로 며칠(분쟁이면 몇 주) 더 간다. 릴레이는
 * NIP-40에 따라 **지난 만료를 가진 이벤트를 거절하고, 저장된 것도 내주지 않는다** —
 * 막바지에 클레임된 주문은 그 순간부터 상태 발행이 전부 실패했다.
 *
 * 타임락(8064블록 ≈ 56일)이 거래의 절대 상한이므로 그보다 넉넉히 잡는다.
 */
export const ONCHAIN_EVENT_HORIZON_SEC = 70 * DAY;

/**
 * 후원자 앱이 원화를 보내기 전에 요구하는 **타임락 잔여** (블록, ≈1주).
 *
 * 타임락이 다 차면 고객이 혼자 에스크로를 뺄 수 있다. 원화는 T0 + 105분 안에 흐르므로 정상이면 8064블록이
 * 거의 전량 남아 있다 — 이 문턱은 리오그·긴 정체 같은 사고에서 되돌릴 수 없는 송금을 막는 안전망이다.
 */
export const TIMELOCK_REMIT_THRESHOLD_BLOCKS = 1008;

/** 종결 이벤트가 만료된 오더 위에 실릴 때 줄 유예 (라이트닝 `lnRetention`과 같은 규칙) */
export const TERMINAL_GRACE_SEC = 7 * DAY;

/**
 * 창 길이 묶음 — 데몬이 운영자 상태에 실어 보내고 어드민이 자기 값과 견준다(2026-09-25). 데몬만 옛 이미지로
 * 돌면 오더에 찍히는 마감과 앱 문구가 어긋난다(입금 "2시간 안에"인데 카운트다운은 6시간) — 그걸 화면에 드러낸다.
 */
export const ONCHAIN_WINDOWS = {
  funding: FUNDING_WINDOW_SEC,
  presign: PRESIGN_WINDOW_SEC,
  account: ACCOUNT_WINDOW_SEC,
  krw: KRW_WINDOW_SEC,
  cosign: COSIGN_WINDOW_SEC,
} as const;

export type OnchainWindows = Record<keyof typeof ONCHAIN_WINDOWS, number>;

/**
 * 총 옵션 창의 상한(지금 15+60+30 = 105분). 앞 두 마감이 T0에 묶여 있어 **합이 이걸 못 넘는다.**
 * 보증금은 이 구간의 변동폭을 덮어야 한다(§2.4) — 계좌 창을 늘리며 60분에서 늘었다(`ACCOUNT_WINDOW_SEC`).
 */
export const MAX_OPTION_WINDOW_SEC = PRESIGN_WINDOW_SEC + ACCOUNT_WINDOW_SEC + KRW_WINDOW_SEC;

/**
 * **클레임이 성립한 뒤 마지막 몰수 결정까지의 최악 소요** (§6.0 최악 소요 시간).
 *
 * ```
 * bonded 2h + 옵션 창 105m + cosign 24h + 판정 예산 24h ≈ 52시간
 * ```
 *
 * ⚠️ **보증금 HTLC가 이 구간을 덮어야 한다.** 안 덮으면 거래 도중에 보증금이
 * LN 만료로 환불되고, 그 순간 **몰수라는 억제 장치가 통째로 사라진다.**
 * 의뢰 만료(최대 7일)만 보고 CLTV를 잡으면 **막바지에 클레임된 주문이 정확히
 * 그 상태가 된다** — 만료 1시간 전에 클레임하면 보증금은 하루 남짓 사는데
 * 거래는 52시간이 걸릴 수 있다.
 *
 * 몰수는 **결정 시점**에 집행되므로(리뷰 #8) 종결 tx 컨펌 대기(`settling`)는
 * 여기 안 들어간다. 그 자리를 분쟁 판정 예산이 대신한다.
 */
export const MAX_TRADE_DURATION_SEC =
  FUNDING_WINDOW_SEC + MAX_OPTION_WINDOW_SEC + COSIGN_WINDOW_SEC + DISPUTE_RULING_BUDGET_SEC;

/**
 * 펀딩 마감을 찍는다.
 *
 * ⚠️ **리오그로 `bonded`에 돌아올 때도 이걸 다시 부른다.** 그대로 두면 마감이
 * 이미 지난 상태로 복귀해 **체인 사고로 정직한 고객이 몰수된다**(§4.1c).
 */
export function fundingDeadlineFrom(bondedAt: number): number {
  return bondedAt + FUNDING_WINDOW_SEC;
}

/** T0 + 15분 — 후원자 사전서명 마감 */
export function presignDeadlineFrom(fundedAt: number): number {
  return fundedAt + PRESIGN_WINDOW_SEC;
}

/** `presigned` + `ACCOUNT_WINDOW_SEC` — 고객 계좌 공개 마감 */
export function accountDeadlineFrom(presignedAt: number): number {
  return presignedAt + ACCOUNT_WINDOW_SEC;
}

/** 계좌 공개 + 30분 — 후원자 송금 마감 (O-013: 고객 지연이 여기를 안 깎는다) */
export function krwDeadlineFrom(accountSentAt: number): number {
  return accountSentAt + KRW_WINDOW_SEC;
}

/** `remitted` + 24시간 — 고객 cosign 마감. 넘기면 `disputed` 강제 전이 (O-010) */
export function cosignDeadlineFrom(remittedAt: number): number {
  return remittedAt + COSIGN_WINDOW_SEC;
}

/**
 * 핸들러가 **지금 이 행동을 받아도 되는지** 보는 마감들.
 *
 * 워처만 마감을 보고 핸들러가 안 보면, 워처 틱(30초) 사이에 들어온 늦은 사전서명·
 * 늦은 계좌·늦은 송금 주장이 그대로 받아들여진다(리뷰 #8). 마감은 **양쪽이 같은
 * 함수로** 본다.
 */
export function presignDeadlineOf(order: { fundedAt?: number; presignDeadline?: number }): number | undefined {
  // 데몬이 찍은 값이 먼저다 — 화면과 데몬이 같은 숫자를 본다. 없으면(옛 오더) 계산한다
  return order.presignDeadline ?? (order.fundedAt ? presignDeadlineFrom(order.fundedAt) : undefined);
}

export function accountDeadlineOf(order: { presignedAt?: number; accountDeadline?: number }): number | undefined {
  return order.accountDeadline ?? (order.presignedAt ? accountDeadlineFrom(order.presignedAt) : undefined);
}

export function cosignDeadlineOf(order: { remittedAt?: number; cosignDeadline?: number }): number | undefined {
  return order.cosignDeadline ?? (order.remittedAt ? cosignDeadlineFrom(order.remittedAt) : undefined);
}

export function krwDeadlineOf(
  order: { krwDeadline?: number; accountSentAt?: number },
): number | undefined {
  if (order.krwDeadline) return order.krwDeadline;
  return order.accountSentAt ? krwDeadlineFrom(order.accountSentAt) : undefined;
}

/** 마감이 있고 지났는가. **마감을 모르면 지난 것으로 본다** — 모르는 걸 "여유 있다"로 치지 않는다 */
export function isPast(deadline: number | undefined, now: number): boolean {
  return deadline === undefined || now >= deadline;
}

/**
 * 오더 이벤트(kind 30402)에 실을 `expiration`.
 *
 * - `listed` — 의뢰 만료 그대로. 오더북에서 저절로 사라져야 한다
 * - 터미널 — 이미 지났으면 유예를 준다(종결을 알리는 이벤트는 도달해야 한다)
 * - 그 사이(거래 중) — **의뢰 만료와 무관하게** 거래가 끝날 때까지 산다
 */
export function onchainOrderEventExpiration(
  state: string,
  listingExpiration: number,
  now: number,
  terminal: boolean,
): number {
  if (state === 'listed') return listingExpiration;
  if (terminal) return listingExpiration > now ? listingExpiration : now + TERMINAL_GRACE_SEC;
  return Math.max(listingExpiration, now + ONCHAIN_EVENT_HORIZON_SEC);
}

/** 요청·통지 이벤트(kind 1111)의 `expiration` — 거래가 끝날 때까지 산다 */
export function onchainMessageExpiration(now: number): number {
  return now + ONCHAIN_EVENT_HORIZON_SEC;
}

export interface OnchainDeadline {
  /** 마감 시각 (unix초) */
  at: number;
  /** 화면에 쓰는 이름 */
  label: string;
  /** 넘기면 무엇을 잃는가. 없으면 손실이 아니다(경고성 마감) */
  penalty?: string;
}

/** 마감을 보는 사람. 없으면 운영자(어드민) — 역할 이름(고객·후원자)으로 적는다 */
export type DeadlineViewer = 'customer' | 'sponsor';

/**
 * 창 길이를 문구로 — "2시간", "1시간", "15분", "1시간 30분". 문구에 숫자를 박아 두면 창을 바꿀 때 따로
 * 논다(6시간·15분이 앱·진행도·푸시 여섯 군데에 박혀 있었다, 2026-09-25).
 */
export function durationText(sec: number): string {
  const h = Math.floor(sec / HOUR);
  const m = Math.round((sec % HOUR) / MINUTE);
  if (h > 0 && m > 0) return `${h}시간 ${m}분`;
  return h > 0 ? `${h}시간` : `${m}분`;
}

type DeadlineKind = 'funding' | 'presign' | 'account' | 'krw' | 'cosign';

/**
 * 넘기면 무엇이 되는가 — **보는 사람 입장에서.** 유저 화면은 "고객·후원자"가 아니라 나·상대방으로 말한다
 * (그 이름은 쿠팡 대리구매 시절의 흔적이라 온체인에서는 누가 누구인지 안 읽힌다, 2026-09-25).
 * 처리는 `OUTCOME_RULES`와 같아야 한다. 몰수금의 행방은 적지 않는다(`progress.ts` 머리말).
 */
const DEADLINES: Record<DeadlineKind, {
  owner: DeadlineViewer;
  label: string;
  admin: string;
  mine: string;
  theirs: string;
}> = {
  funding: {
    owner: 'customer', label: '입금 컨펌 마감',
    admin: '넘기면 거래가 취소되고 고객 보증금이 몰수됩니다',
    mine: '시간 안에 입금이 컨펌되지 않으면 거래가 취소되고 내 보증금이 몰수됩니다',
    theirs: '상대방 입금이 시간 안에 컨펌되지 않으면 거래가 취소되고 상대방 보증금이 몰수됩니다. 내 보증금은 돌려받습니다',
  },
  presign: {
    owner: 'sponsor', label: '사전서명 마감',
    admin: '넘기면 환불되고 후원자 보증금이 몰수됩니다',
    mine: '시간 안에 사전서명이 안 되면 거래가 환불되고 내 보증금이 몰수됩니다',
    theirs: '상대방이 시간 안에 서명하지 않으면 환불로 넘어가고 상대방 보증금이 몰수됩니다',
  },
  account: {
    owner: 'customer', label: '계좌 전달 마감',
    admin: '넘기면 거래가 취소되고 고객 보증금이 몰수됩니다',
    mine: '시간 안에 계좌를 보내지 않으면 거래가 취소되고 내 보증금이 몰수됩니다',
    theirs: '상대방이 시간 안에 계좌를 보내지 않으면 거래가 취소되고 상대방 보증금이 몰수됩니다. 내 보증금은 돌려받습니다',
  },
  krw: {
    owner: 'sponsor', label: '원화 송금 마감',
    admin: '넘기면 환불되고 후원자 보증금이 몰수됩니다',
    mine: '시간 안에 송금하지 않으면 거래가 환불되고 내 보증금이 몰수됩니다',
    theirs: '상대방이 시간 안에 송금하지 않으면 환불로 넘어가고 상대방 보증금이 몰수됩니다',
  },
  cosign: {
    owner: 'customer', label: '입금 확인 마감',
    admin: '넘기면 분쟁으로 넘어갑니다 (동의를 묻지 않습니다)',
    mine: '시간 안에 확인하지 않으면 분쟁으로 넘어갑니다',
    theirs: '상대방이 시간 안에 확인하지 않으면 분쟁으로 넘어갑니다',
  },
};

function deadline(kind: DeadlineKind, at: number, viewer: DeadlineViewer | undefined): OnchainDeadline {
  const d = DEADLINES[kind];
  const penalty = viewer === undefined ? d.admin : viewer === d.owner ? d.mine : d.theirs;
  return { at, label: d.label, penalty };
}

/**
 * **지금 이 주문에 걸려 있는 마감.**
 *
 * 화면이 "몇 분 남았는지"를 보여주려면 어느 시계가 도는지 한 곳에서 알아야 한다.
 * 상태마다 시계가 다르고, `presigned`는 **한 상태 안에서 주인이 바뀐다**(O-013).
 *
 * `null`이면 마감이 없는 구간이다 — `disputed`(자동 해소가 어느 방향이든 탈취라서,
 * §7.5)와 `refunding`(고객 자기 돈이고 보증금은 결정 때 이미 처리됐다).
 */
export function currentOnchainDeadline(
  order: {
    state: string;
    expiration: number;
    fundingDeadline?: number;
    fundedAt?: number;
    presignDeadline?: number;
    presignedAt?: number;
    accountDeadline?: number;
    accountSentAt?: number;
    krwDeadline?: number;
    remittedAt?: number;
    cosignDeadline?: number;
    settlingAt?: number;
    updatedAt: number;
  },
  viewer?: DeadlineViewer,
): OnchainDeadline | null {
  switch (order.state) {
    case 'listed':
      return order.expiration > 0
        ? { at: order.expiration, label: '의뢰 만료' }
        : null;

    case 'bonded':
      return order.fundingDeadline ? deadline('funding', order.fundingDeadline, viewer) : null;

    case 'funded': {
      const at = presignDeadlineOf(order);
      return at ? deadline('presign', at, viewer) : null;
    }

    case 'presigned': {
      // 한 상태 안에서 주인이 바뀐다 — 계좌가 나가기 전엔 고객, 그 뒤엔 후원자.
      if (!order.accountSentAt) {
        const at = accountDeadlineOf(order);
        return at ? deadline('account', at, viewer) : null;
      }
      return deadline('krw', order.krwDeadline ?? krwDeadlineFrom(order.accountSentAt), viewer);
    }

    case 'remitted': {
      const at = cosignDeadlineOf(order);
      return at ? deadline('cosign', at, viewer) : null;
    }

    case 'settling':
      // 하드 마감이 아니다 — 넘겨도 잃는 게 없고 CPFP 안내만 뜬다.
      return { at: (order.settlingAt ?? order.updatedAt) + SETTLING_WARN_SEC, label: '컨펌 대기' };

    // `refunding` — 마감이 없다. 고객 자기 돈이고, 보증금은 결정 때 이미 처리됐다
    // (O-009: 머물러도 아무도 이득을 못 본다). 최후에는 타임락이 받는다.

    default:
      return null;
  }
}

/** 의뢰 만료가 상한 안인지 — 넘으면 보증금 인보이스를 만들 수 없다(§2.2) */
export function isOrderExpiryAllowed(expiration: number, now: number): boolean {
  return expiration > now && expiration - now <= MAX_ORDER_EXPIRY_SEC;
}
