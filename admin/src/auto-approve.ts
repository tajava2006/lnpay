/**
 * 클레임 자동 승인
 *
 * ── 왜 이것만 자동인가
 *
 * 어드민 화면에서 눌러야 하는 버튼은 넷이다.
 *
 *   approveOrder        claimed → verified
 *   revertClaim         클레임 철회 (선택)
 *   disburseSponsor     지급 재시도 (평소엔 paid에서 자동 실행됨)
 *   resolveDispute*     분쟁 판정
 *
 * 이 중 **판단이 필요한 건 분쟁 판정뿐**이다. 철회와 재시도는 예외 상황의
 * 수동 개입이라 평소 흐름을 막지 않는다. 그런데 `approveOrder`는 평소 흐름의
 * 한가운데 있으면서 정작 어드민이 고를 게 없다 — 유동성 검증이 이 단계에서
 * 빠진(2026-09-18) 뒤로는 그냥 "눌러야 진행되는 의식"이 됐다.
 *
 * 그래서 이 하나만 자동화한다. 어드민이 접속만 해 있으면 거래가 완주한다.
 *
 * ── 그래도 스위치를 두는 이유
 *
 * 돈이 걸린 경로라 "지금은 내가 보고 넘기겠다"가 가능해야 한다. 기본은 켜두되
 * 끌 수 있게 한다.
 *
 * ── 왜 handleClaim이 아니라 폴링에서 부르나
 *
 * 후원자 보증금이 켜져 있으면 클레임 직후에는 아직 미납이다. 납부는 나중에
 * invoice-watcher가 감지한다. handleClaim에서 한 번 시도하고 마는 구조면
 * 그 경우를 영영 놓친다. 주기적으로 훑으면 "조건이 갖춰지는 순간" 자연히 넘어가고,
 * 일시적 실패(시세 피드 끊김 등)도 다음 턴에 재시도된다.
 */
import type { Order } from '@sajwo-tracker/shared';

const KEY = 'auto-approve-enabled';

export function isAutoApproveEnabled(): boolean {
  // 기본 켜짐. 명시적으로 끈 적이 있을 때만 끈다.
  return localStorage.getItem(KEY) !== 'off';
}

export function setAutoApproveEnabled(on: boolean): void {
  localStorage.setItem(KEY, on ? 'on' : 'off');
}

export interface AutoApproveContext {
  /** 후원자 보증금을 요구하는 설정인가 */
  sponsorDepositRequired: boolean;
  /** 지금 시각 (unix seconds) */
  now: number;
}

/**
 * 이 오더를 자동으로 승인해도 되는가.
 *
 * 순수 함수로 떼어낸 이유: 자동화의 판정 기준이 곧 "어드민이 눈으로 확인하던
 * 것"이라, 조건이 슬그머니 느슨해지면 아무도 모르게 승인이 남발된다.
 * 테스트로 고정할 수 있게 부수효과를 뺐다.
 */
export function shouldAutoApprove(order: Order, ctx: AutoApproveContext): boolean {
  if (order.state !== 'claimed') return false;

  // 클레임이 붙어 있어야 한다. sponsorPubkey 없는 claimed는 정상 상태가 아니다.
  if (!order.sponsorPubkey) return false;

  // 만료된 오더를 승인하면 홀드 인보이스 만료가 음수가 되어 approveOrder가
  // 어차피 실패한다. 매 턴 헛 시도를 하지 않도록 여기서 거른다.
  if (order.expiration <= ctx.now) return false;

  // 보증금을 요구하는 설정이면 납부 전까지는 넘기지 않는다.
  // 이건 스팸 방어라 자동화가 건너뛸 수 있는 종류가 아니다.
  if (ctx.sponsorDepositRequired && !order.sponsorDepositPaymentHash) return false;

  return true;
}
