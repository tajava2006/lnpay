/**
 * 오더 상태별 메타데이터
 *
 * Admin FSM 상태의 표시명, 색상 등을 중앙에서 관리.
 */

import type { OrderState } from '@sajwo-tracker/shared';

export interface OrderStateMeta {
  label: string;
  bgColor: string;
  textColor: string;
  isFinal: boolean;
}

export const ORDER_STATE_META: Record<OrderState, OrderStateMeta> = {
  requested: {
    label: '요청됨',
    bgColor: '#FEF3C7',
    textColor: '#D97706',
    isFinal: false,
  },
  claimed: {
    label: '클레임됨',
    bgColor: '#DBEAFE',
    textColor: '#1E40AF',
    isFinal: false,
  },
  verified: {
    label: '검증됨',
    bgColor: '#E0E7FF',
    textColor: '#4F46E5',
    isFinal: false,
  },
  escrowed: {
    label: '에스크로',
    bgColor: '#EDE9FE',
    textColor: '#7C3AED',
    isFinal: false,
  },
  paid: {
    label: '완료',
    bgColor: '#D1FAE5',
    textColor: '#065F46',
    isFinal: true,
  },
  cancelled: {
    label: '취소',
    bgColor: '#F3F4F6',
    textColor: '#6B7280',
    isFinal: true,
  },
};

export function getStateMeta(state: OrderState): OrderStateMeta {
  return ORDER_STATE_META[state];
}
