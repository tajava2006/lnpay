/**
 * 서명 요청을 언제 보냈는가 (재촉 간격용)
 *
 * ── 종결 대기 스토어를 없앤 이유 (리뷰 #8)
 *
 * 전에는 "어드민 서명이 든 환불 PSBT"를 이 기기 localStorage에 들고 있었다
 * (`pending-settlement-store`). 셋이 잘못이었다:
 *
 * 1. **결정이 기기에만 있었다.** 기기를 옮기면 사라지고, 새 기기가 **다른 사유로**
 *    다시 결정했다 — reserve 미달로 접은 주문이 후원자 이탈로 재판정돼 후원자가
 *    부당하게 몰수될 수 있었다.
 * 2. **어드민이 먼저 서명했다.** 고객 손에 완성 가능한 환불 tx가 들려 있었고,
 *    그걸로 원화를 받은 뒤 빠져나갈 수 있었다.
 * 3. **재촉 코드가 없었다.** 첫 전달이 실패하면 영영 다시 안 갔다.
 *
 * 이제 결정(사유·수수료)은 **오더 이벤트**에 실리고, tx는 그 값으로 어느 기기에서든
 * 한 바이트까지 같게 다시 만든다. 어드민은 **마지막에** 서명한다. 여기 남는 건
 * "마지막으로 요청을 보낸 시각" 하나뿐이고, 잃어도 요청을 한 번 더 보낼 뿐이다.
 */
const STORE_KEY = 'admin:onchain-sign-requested';

type RequestLog = Record<string, number>;

function load(): RequestLog {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as RequestLog) : {};
  } catch {
    return {};
  }
}

let log: RequestLog = load();

export function lastSignatureRequestAt(orderId: string): number | undefined {
  return log[orderId];
}

export function markSignatureRequested(orderId: string, at: number): void {
  log = { ...log, [orderId]: at };
  localStorage.setItem(STORE_KEY, JSON.stringify(log));
}

/** @testing-only */
export function _resetForTesting(): void {
  log = {};
  localStorage.removeItem(STORE_KEY);
}
