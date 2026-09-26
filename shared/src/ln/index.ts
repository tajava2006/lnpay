/**
 * 라이트닝 트랙 공통 — 데몬·유저 앱·어드민 앱이 같이 본다.
 * 브라우저에 기대지 않는다(데몬이 Node에서 부른다).
 */
export {
  canTransition, computePayoutSat, computeEscrowSat, isPayoutAmountExact,
} from './state-machine';
export { CLOSE_RULES, LN_CLOSE_REASON_LABEL, expiryReasonFor, isLnCloseReason } from './outcomes';
export type { CloseRule, Disposition, LnCloseReason } from './outcomes';
export {
  LN_ACTIVE_RETENTION_SEC, LN_MAX_DEADLINE_LEAD_SEC, LN_MIN_CLAIM_LEAD_SEC, LN_MIN_SPONSOR_INVOICE_LIFETIME_SEC,
  LN_REQUEST_RETENTION_SEC,
  LN_TERMINAL_RETENTION_SEC, isClaimableLn, isStoredLnOrder, lnOrderTags, lnRequestExpiration, lnRetention, parseLnOrderEvent,
} from './order';
export type { LnOrderFields } from './order';
