/**
 * 라이트닝 거래를 닫는 사유 → 에스크로·보증금 처리 (PLAN-DAEMON §7)
 *
 * **사유가 곧 처리다.** 전이만 보고 판단하면 정반대로 처리한다 — `cancelled` 하나에 고객 보증금을
 * 돌려주는 경우(후원자가 붙기 전)와 가져가는 경우(후원자를 붙여놓고 에스크로를 안 냄)가 섞여 있다.
 * 온체인 `OUTCOME_RULES`와 같은 원칙이고, `Record`라 사유를 추가하면 여기서 빌드가 깨진다.
 *
 * 프론트 어드민 시절에는 이 표가 `deposit-lifecycle.ts`의 if 사슬에 흩어져 있었고, 몇 칸은
 * "어드민 수동 판단"으로 비어 있었다(후원자 보증금이 `cancelled`·`escrowed`에서 아무도 안 건드림).
 * 사람이 안 보면 CLTV까지 묶였다가 저절로 환불됐다 — 몰수해야 할 이탈도 공짜가 됐다.
 */
import type { OrderState } from '../constants';

export type Disposition = 'refund' | 'forfeit';

export type LnCloseReason =
  | 'paid'
  | 'sponsor_wins'
  | 'customer_wins'
  | 'admin_closed'
  /** 고객이 후원자가 붙기 전에 접었다 */
  | 'cancel:customer'
  /** 고객이 후원자를 붙여놓고(클레임·승인 뒤) 접었다 */
  | 'cancel:customer-after-claim'
  /** 승인 뒤 고객이 에스크로를 기한 안에 안 냈다 */
  | 'cancel:unpaid-escrow'
  /** 기한까지 후원자가 안 붙었다 */
  | 'expired:no-sponsor'
  /** 기한까지 승인이 안 됐다(후원자 보증금 미납·시세 부재 등) — 누구 탓으로 단정할 수 없다 */
  | 'expired:not-approved'
  /** 기한까지 에스크로가 안 들어왔다 */
  | 'expired:unpaid-escrow'
  /** 에스크로는 들어왔는데 후원자가 받을 인보이스를 끝내 안 냈다 */
  | 'expired:no-invoice'
  /** 후원자 인보이스까지 받았는데 고객이 계좌를 끝내 안 보냈다 — 후원자는 송금할 수 없었다 */
  | 'expired:no-account'
  /** 계좌까지 나갔는데 송금 완료도 입금 확인도 없이 기한이 지났다 */
  | 'expired:no-remit';

export interface CloseRule {
  /** 도착할 종결 상태 */
  terminal: OrderState;
  /** 에스크로 홀드 인보이스 — settle은 BTC를 받는다(지급 전제), cancel은 고객에게 돌려준다 */
  escrow: 'settle' | 'cancel';
  customerDeposit: Disposition;
  sponsorDeposit: Disposition;
}

export const CLOSE_RULES: Record<LnCloseReason, CloseRule> = {
  paid: { terminal: 'paid', escrow: 'settle', customerDeposit: 'refund', sponsorDeposit: 'refund' },
  sponsor_wins: { terminal: 'sponsor_wins', escrow: 'settle', customerDeposit: 'refund', sponsorDeposit: 'refund' },
  // 고객 승 = 후원자가 원화를 안 보냈다고 판정됐다
  customer_wins: { terminal: 'customer_wins', escrow: 'cancel', customerDeposit: 'refund', sponsorDeposit: 'forfeit' },
  // 사람이 끊었다 — 몰수는 별도 판단이고, 자동으로 남의 돈을 가져가는 기본값을 두지 않는다
  admin_closed: { terminal: 'admin_closed', escrow: 'cancel', customerDeposit: 'refund', sponsorDeposit: 'refund' },

  'cancel:customer': { terminal: 'cancelled', escrow: 'cancel', customerDeposit: 'refund', sponsorDeposit: 'refund' },
  // 후원자 시간 낭비 — 고객 몰수, 후원자는 잘못이 없다
  'cancel:customer-after-claim': { terminal: 'cancelled', escrow: 'cancel', customerDeposit: 'forfeit', sponsorDeposit: 'refund' },
  'cancel:unpaid-escrow': { terminal: 'cancelled', escrow: 'cancel', customerDeposit: 'forfeit', sponsorDeposit: 'refund' },

  'expired:no-sponsor': { terminal: 'expired', escrow: 'cancel', customerDeposit: 'refund', sponsorDeposit: 'refund' },
  'expired:not-approved': { terminal: 'expired', escrow: 'cancel', customerDeposit: 'refund', sponsorDeposit: 'refund' },
  'expired:unpaid-escrow': { terminal: 'expired', escrow: 'cancel', customerDeposit: 'forfeit', sponsorDeposit: 'refund' },
  // PLAN-DAEMON §14 D4 — 인보이스도 안 내고 떠난 건 공짜 옵션이다. 닫는다
  'expired:no-invoice': { terminal: 'expired', escrow: 'cancel', customerDeposit: 'refund', sponsorDeposit: 'forfeit' },
  // 계좌를 안 보내 후원자 시간만 버렸다 — 본자금을 뺏을 잘못은 아니지만 보증금 몰수는 맞다(2026-09-25).
  // 고객 보증금이 에스크로 뒤에도 살아 있는 이유다(예전엔 에스크로 때 돌려줘서 이 몰수가 불가능했다)
  'expired:no-account': { terminal: 'expired', escrow: 'cancel', customerDeposit: 'forfeit', sponsorDeposit: 'refund' },
  // 계좌까지 받은 뒤는 원화가 오갔을 수 있다 — 몰수가 피해자를 칠 수 있어 돌려준다(D4)
  'expired:no-remit': { terminal: 'expired', escrow: 'cancel', customerDeposit: 'refund', sponsorDeposit: 'refund' },
};

/** 화면에 쓰는 사유 문장 — 어드민 상세와 유저 앱 내역이 같은 말을 한다 */
export const LN_CLOSE_REASON_LABEL: Record<LnCloseReason, string> = {
  paid: '정상 완료',
  sponsor_wins: '분쟁 판정 — 후원자 승',
  customer_wins: '분쟁 판정 — 고객 승 (후원자 보증금 몰수)',
  admin_closed: '운영자가 종료 (보증금 전부 환불)',
  'cancel:customer': '고객 취소 (후원자가 붙기 전)',
  'cancel:customer-after-claim': '고객 취소 — 후원자가 붙은 뒤 (고객 보증금 몰수)',
  'cancel:unpaid-escrow': '고객이 결제 기한 안에 결제하지 않음 (고객 보증금 몰수)',
  'expired:no-sponsor': '기한까지 후원자가 없음',
  'expired:not-approved': '기한까지 승인되지 않음',
  'expired:unpaid-escrow': '기한까지 결제되지 않음 (고객 보증금 몰수)',
  'expired:no-invoice': '후원자가 받을 인보이스를 끝내 내지 않음 (후원자 보증금 몰수)',
  'expired:no-account': '고객이 기한까지 계좌를 보내지 않음 (고객 보증금 몰수)',
  'expired:no-remit': '기한까지 송금 완료가 없음 (보증금 전부 환불)',
};

export function isLnCloseReason(value: string | undefined): value is LnCloseReason {
  return value !== undefined && Object.prototype.hasOwnProperty.call(CLOSE_RULES, value);
}

/**
 * 쿠팡 기한이 지났을 때 이 상태의 거래를 어떤 사유로 닫는가. `null`이면 닫지 않는다.
 *
 * `remitted` 이후는 닫지 않는다 — 원화가 갔다는 주장이 있으면 분쟁 판정(사람)으로 끝낸다.
 */
export function expiryReasonFor(state: OrderState, hasSponsor: boolean, accountSent = false): LnCloseReason | null {
  switch (state) {
    case 'requested': return 'expired:no-sponsor';
    case 'claimed': return hasSponsor ? 'expired:not-approved' : 'expired:no-sponsor';
    case 'verified': return 'expired:unpaid-escrow';
    case 'escrowed': return 'expired:no-invoice';
    // 계좌가 나갔는지로 가른다 — 안 나갔으면 고객 탓(후원자는 보낼 곳이 없었다), 나갔으면 누구 탓인지 모른다
    case 'invoiced': return accountSent ? 'expired:no-remit' : 'expired:no-account';
    default: return null;
  }
}
