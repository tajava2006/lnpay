/**
 * 상태 배지의 문구와 색 — 한 곳
 *
 * ── 왜 공유로 옮겼나
 *
 * 이 표가 **다섯 군데에 복붙돼 있었다** (어드민 오더북·어드민 히스토리·어드민
 * 클레임목록·후원자 상세·유저 히스토리). 내용은 전부 같았다.
 *
 * `invoiced`를 추가했을 때 한 곳만 고쳤고, 나머지 넷에서는 폴백이 걸려 배지에
 * **영어 그대로 "invoiced"가 회색으로** 떴다(2026-09-19 관측). `TERMINAL_STATES`가
 * 다섯 군데 복붙돼 있어서 종결된 의뢰가 오더북에 남았던 것과 **같은 사고**다.
 *
 * ── 폴백을 없앤 이유
 *
 * 호출부가 `stateLabel[s] ?? s`로 받아내고 있었다. 그래서 상태를 추가해도
 * 아무것도 깨지지 않고 **조용히 영어가 새어나왔다.**
 *
 * 여기서는 `Record<OrderState, ...>`로 못박는다. `ORDER_STATES`에 상태를 하나
 * 추가하면 이 파일이 **컴파일 에러**를 낸다. 화면에서 발견하는 대신 빌드에서
 * 막히는 게 이 파일의 존재 이유다.
 */
import type { OrderState } from './constants';

export interface StateDisplay {
  /** 배지에 쓰는 한국어 */
  label: string;
  /** 글자색 */
  color: string;
  /** 배경색 */
  bg: string;
}

export const STATE_DISPLAY: Record<OrderState, StateDisplay> = {
  requested: { label: '요청됨', color: '#D97706', bg: '#FEF3C7' },
  claimed: { label: '클레임됨', color: '#2563EB', bg: '#DBEAFE' },
  verified: { label: '검증됨', color: '#4F46E5', bg: '#E0E7FF' },
  escrowed: { label: '에스크로', color: '#7C3AED', bg: '#EDE9FE' },
  invoiced: { label: '계좌 전달 대기', color: '#9333EA', bg: '#F3E8FF' },
  remitted: { label: '송금 주장', color: '#BE185D', bg: '#FCE7F3' },
  paid: { label: '완료', color: '#059669', bg: '#D1FAE5' },
  cancelled: { label: '취소', color: '#6B7280', bg: '#F3F4F6' },
  sponsor_wins: { label: '후원자 승리', color: '#0F766E', bg: '#CCFBF1' },
  customer_wins: { label: '고객 승리', color: '#0E7490', bg: '#CFFAFE' },
  admin_closed: { label: '강제 종결', color: '#B45309', bg: '#FEF3C7' },
  expired: { label: '기한 만료', color: '#6B7280', bg: '#F3F4F6' },
};

/**
 * 배지 정보를 꺼낸다.
 *
 * 릴레이에서 온 문자열은 타입이 보장되지 않으므로(오래된 클라이언트, 손상된
 * 이벤트) 넓은 타입을 받는다. 모르는 값이면 그 문자열을 그대로 보여준다 —
 * 여기는 진짜 미지의 입력이라 폴백이 맞고, 위의 `Record`가 **우리가 아는 상태**의
 * 누락을 이미 막고 있다.
 */
export function stateDisplay(state: string): StateDisplay {
  return STATE_DISPLAY[state as OrderState] ?? { label: state, color: '#666666', bg: '#F3F4F6' };
}
