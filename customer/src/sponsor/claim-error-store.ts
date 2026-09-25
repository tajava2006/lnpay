/**
 * 반응형 클레임 가격 에러 스토어
 *
 * Admin이 클레임 가격 범위 초과로 거부했을 때 수신한 에러를 보관하고,
 * useSyncExternalStore로 OrderCard UI에 자동 전파한다.
 * 영구 저장 불필요 (세션 알림 목적).
 */
import { nowSec } from '@sajwo-tracker/shared';

/**
 * 어드민이 보낸 인보이스 거절 사유.
 *
 * 예전엔 클레임 시 금액이 시세 범위를 벗어난 경우만 있었다(그래서 이름이
 * claim-price-error). 인보이스를 에스크로 이후에 받게 되면서 사유가 늘었고,
 * 어느 쪽이든 **조용히 실패하면 후원자는 등록됐다고 믿고 오지 않을 계좌를
 * 기다린다** — 그래서 이유를 반드시 화면에 띄운다.
 */
export type InvoiceRejectReason =
  | 'DECODE_FAILED'
  | 'AMOUNT_MISMATCH'
  | 'EXPIRES_TOO_SOON'
  | 'EXPIRED_BEFORE_PAYOUT'
  | 'LIQUIDITY_WARNING'
  | 'ESCROW_ENDING_SOON';

export interface ClaimPriceError {
  reason?: InvoiceRejectReason;
  orderId: string;
  expectedSats: number;
  receivedAt: number;
}

type ErrorMap = Record<string, ClaimPriceError>;
type Listener = () => void;

let errors: ErrorMap = {};
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// ── useSyncExternalStore 호환 API ──────────────────

export function subscribeClaimErrors(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getClaimErrorSnapshot(): ErrorMap {
  return errors;
}

// ── 뮤테이션 API ───────────────────────────────────

export function setClaimError(orderId: string, expectedSats: number, reason?: InvoiceRejectReason): void {
  errors = {
    ...errors,
    [orderId]: { orderId, expectedSats, reason, receivedAt: nowSec() },
  };
  notify();
}

export function clearClaimError(orderId: string): void {
  if (!errors[orderId]) return;
  const { [orderId]: _, ...rest } = errors;
  errors = rest;
  notify();
}

/** 거절 사유를 사람이 읽을 문장으로. 코드 그대로 보여주면 아무 도움이 안 된다. */
export function rejectReasonText(e: ClaimPriceError): string {
  switch (e.reason) {
    case 'DECODE_FAILED':
      return '인보이스를 읽지 못했습니다. 전체를 다시 복사해 주세요.';
    case 'AMOUNT_MISMATCH':
      return `금액이 다릅니다. ${e.expectedSats.toLocaleString()} sats로 정확히 다시 만들어 주세요.`;
    case 'EXPIRES_TOO_SOON':
      return '유효시간이 너무 짧습니다. 최소 6시간 이상으로 만들어 주세요.';
    case 'EXPIRED_BEFORE_PAYOUT':
      return '인보이스가 만료됐습니다. 새로 만들어 등록해 주세요 — 거래는 그대로 진행됩니다.';
    case 'LIQUIDITY_WARNING':
      return '경로 확인에 실패했습니다. 등록은 됐지만 받지 못할 수 있으니 인바운드 용량을 확인해 주세요.';
    case 'ESCROW_ENDING_SOON':
      return '고객 결제(에스크로)가 곧 만료돼 인보이스를 받지 않았습니다. 원화를 보내지 마세요 — 거래는 곧 종료됩니다.';
    default:
      return `현재 시세 기준 ${e.expectedSats.toLocaleString()} sats로 재발행해 주세요.`;
  }
}
