/**
 * 온체인 트랙의 마감 시계 (PLAN-ONCHAIN-TRACK §6.2)
 *
 * **마감 없는 상태는 없다**(O-009). 예외는 `disputed` 하나뿐이고, 그건 자동
 * 해소가 어느 방향이든 탈취라서다(§7.5).
 *
 * ```
 * listed ──의뢰 만료(최대 7일)──→ cancelled
 * bonded ──6시간(컨펌까지)──────→ cancelled + 고객 몰수
 * funded ──15분──────────────────→ refund:sponsor-timeout
 *            └ presigned ──5분(계좌 공개)──→ refund:customer-late
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
 *   ② 그런데도 총합이 **T0+50분을 못 넘는다**
 * 마감을 앞 단계에 상대적으로 걸면 후원자가 14:59에 사전서명을 내는 식으로
 * **총 창을 늘릴 수 있다** — 그래서 각 마감을 자기가 통제 못 하는 지점에 앵커한다.
 */
import { PRICE_VALIDITY_MS } from './state-machine';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 의뢰 만료 상한 — 보증금 CLTV 천장(13일)에 여유를 두고 7일 (§2.2) */
export const MAX_ORDER_EXPIRY_SEC = 7 * DAY;

/** `bonded` → 펀딩 **컨펌까지** (§4.1c). 3컨펌(~30분)도 넉넉히 들어간다 */
export const FUNDING_WINDOW_SEC = 6 * HOUR;

/** T0 → 후원자 사전서명. 앱이 깨어나는 시간이지 고민할 시간이 아니다 */
export const PRESIGN_WINDOW_SEC = 15 * MINUTE;

/** `presigned` → 고객이 계좌 공개. 발행 버튼 한 번 */
export const ACCOUNT_WINDOW_SEC = 5 * MINUTE;

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
 * 총 옵션 창의 상한. 앞 두 마감이 T0에 묶여 있어 **합이 이걸 못 넘는다.**
 * 보증금은 이 구간의 변동폭을 덮어야 한다(§2.4).
 */
export const MAX_OPTION_WINDOW_SEC = PRESIGN_WINDOW_SEC + ACCOUNT_WINDOW_SEC + KRW_WINDOW_SEC;

/**
 * **클레임이 성립한 뒤 거래가 끝나기까지의 최악 소요** (§6.0 최악 소요 시간).
 *
 * ```
 * bonded 6h + 옵션 창 50m + cosign 24h + settling 24h ≈ 55시간
 * ```
 *
 * ⚠️ **보증금 HTLC가 이 구간을 덮어야 한다.** 안 덮으면 거래 도중에 보증금이
 * LN 만료로 환불되고, 그 순간 **몰수라는 억제 장치가 통째로 사라진다.**
 * 의뢰 만료(최대 7일)만 보고 CLTV를 잡으면 **막바지에 클레임된 주문이 정확히
 * 그 상태가 된다** — 만료 1시간 전에 클레임하면 보증금은 하루 남짓 사는데
 * 거래는 55시간이 걸릴 수 있다.
 */
export const MAX_TRADE_DURATION_SEC =
  FUNDING_WINDOW_SEC + MAX_OPTION_WINDOW_SEC + COSIGN_WINDOW_SEC + SETTLING_WARN_SEC;

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

/** `presigned` + 5분 — 고객 계좌 공개 마감 */
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

/** 의뢰 만료가 상한 안인지 — 넘으면 보증금 인보이스를 만들 수 없다(§2.2) */
export function isOrderExpiryAllowed(expiration: number, now: number): boolean {
  return expiration > now && expiration - now <= MAX_ORDER_EXPIRY_SEC;
}
