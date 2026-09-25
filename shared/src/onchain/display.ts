/**
 * 온체인 상태 배지 — 한 곳 (PLAN-ONCHAIN-TRACK §5.4)
 *
 * 라이트닝의 `STATE_DISPLAY`와 **같은 규칙**으로 만든다: `Record<OnchainState, …>`로
 * 못박고 폴백(`?? state`)을 쓰지 않는다.
 *
 * 그 폴백 때문에 라이트닝에서 영어 "invoiced"가 다섯 군데 중 넷에 회색으로 떴다
 * (2026-09-19). 상태를 추가해도 아무것도 안 깨지고 **조용히 새어나온 것**이
 * 문제였다. 여기서는 `ONCHAIN_STATES`에 상태를 하나 넣으면 이 파일이
 * **컴파일 에러**를 낸다.
 *
 * 멤풀에서 tx를 봤다는 것은 **상태가 아니라 화면 힌트**다(§4.2). `bonded` 배지
 * 옆에 "멤풀에서 보임 · 컨펌 대기"를 덧붙이는 식으로 쓴다 — 배지 자체를 바꾸지
 * 않는다. 0-conf는 아무 결정도 못 내리므로 상태가 될 수 없다.
 *
 * **문구는 유저 화면이 그대로 쓴다** — 고객·후원자 같은 역할 이름을 넣지 않는다. 그 이름은 쿠팡 대리구매
 * 시절의 흔적이라 온체인(비트코인을 파는 쪽·사는 쪽)에서는 누가 누구인지 안 읽힌다(2026-09-25).
 *
 * 색은 라이트닝 표와 같은 팔레트를 쓰되, 같은 뜻이면 같은 색으로 맞췄다 —
 * `내 거래` 탭이 두 트랙을 한 목록에 섞어 보여주므로(§5.4) 색이 어긋나면
 * 유저가 상태를 색으로 읽는 습관이 깨진다.
 */
import type { StateDisplay } from '../order-display';
import type { OnchainState } from './state-machine';

export const ONCHAIN_STATE_DISPLAY: Record<OnchainState, StateDisplay> = {
  listed:     { label: '오더북 등록',     color: '#D97706', bg: '#FEF3C7' },
  bonded:     { label: '입금 대기',       color: '#2563EB', bg: '#DBEAFE' },
  funded:     { label: '에스크로 확정',   color: '#7C3AED', bg: '#EDE9FE' },
  presigned:  { label: '계좌 전달 대기',  color: '#9333EA', bg: '#F3E8FF' },
  remitted:   { label: '입금 확인 대기',  color: '#BE185D', bg: '#FCE7F3' },
  disputed:   { label: '분쟁 중',         color: '#DC2626', bg: '#FEE2E2' },
  refunding:  { label: '환불 진행',       color: '#B45309', bg: '#FFEDD5' },
  settling:   { label: '종결 tx 대기',    color: '#0891B2', bg: '#CFFAFE' },

  released:   { label: '완료',            color: '#059669', bg: '#D1FAE5' },
  refunded:   { label: '환불',            color: '#6B7280', bg: '#F3F4F6' },
  sponsor_wins: { label: '판정: 송금 인정', color: '#0F766E', bg: '#CCFBF1' },
  customer_wins: { label: '판정: 송금 불인정', color: '#0E7490', bg: '#CFFAFE' },
  cancelled:  { label: '취소',            color: '#6B7280', bg: '#F3F4F6' },
  swept:      { label: '타임락 회수',     color: '#B45309', bg: '#FEF3C7' },
};

/**
 * 배지 정보를 꺼낸다.
 *
 * 릴레이에서 온 문자열은 타입이 보장되지 않으므로(오래된 클라이언트, 손상된
 * 이벤트) 넓은 타입을 받는다. 모르는 값이면 그 문자열을 그대로 보여준다 —
 * 여기는 진짜 미지의 입력이라 폴백이 맞고, 위의 `Record`가 **우리가 아는 상태**의
 * 누락을 이미 막고 있다.
 */
export function onchainStateDisplay(state: string): StateDisplay {
  return ONCHAIN_STATE_DISPLAY[state as OnchainState]
    ?? { label: state, color: '#666666', bg: '#F3F4F6' };
}
