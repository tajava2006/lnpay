/**
 * 주문 상태별 메타데이터
 *
 * 상태의 표시명, 색상, CSS 클래스 등을 중앙에서 관리
 * UI 컴포넌트에서는 이 메타데이터를 참조하여 일관된 표시
 */

import type { OrderStatus } from './types';

export interface OrderStatusMeta {
  /** 상태 코드 (영문) */
  code: OrderStatus;
  /** 한글 표시명 */
  label: string;
  /** 짧은 설명 */
  description: string;
  /** 배경색 (Tailwind-like hex) */
  bgColor: string;
  /** 텍스트색 */
  textColor: string;
  /** CSS 클래스명 (status-xxx 형태) */
  cssClass: string;
  /** 최종 상태 여부 (더 이상 전이 불가) */
  isFinal: boolean;
}

/**
 * 모든 상태의 메타데이터
 */
export const ORDER_STATUS_META: Record<OrderStatus, OrderStatusMeta> = {
  detected: {
    code: 'detected',
    label: '주문 감지',
    description: '무통장입금 주문이 감지되었습니다',
    bgColor: '#E0E7FF', // indigo-100
    textColor: '#3730A3', // indigo-800
    cssClass: 'status-detected',
    isFinal: false,
  },
  requested: {
    code: 'requested',
    label: '사줘 요청',
    description: '다른 사람에게 입금을 요청했습니다',
    bgColor: '#FEF3C7', // amber-100
    textColor: '#92400E', // amber-800
    cssClass: 'status-requested',
    isFinal: false,
  },
  claimed: {
    code: 'claimed',
    label: '응답 대기',
    description: '누군가 사주겠다고 응답했습니다. 입금을 기다리는 중입니다',
    bgColor: '#DBEAFE', // blue-100
    textColor: '#1E40AF', // blue-800
    cssClass: 'status-claimed',
    isFinal: false,
  },
  paid: {
    code: 'paid',
    label: '입금 완료',
    description: '입금이 완료되었습니다',
    bgColor: '#D1FAE5', // green-100
    textColor: '#065F46', // green-800
    cssClass: 'status-paid',
    isFinal: true,
  },
  cancelled: {
    code: 'cancelled',
    label: '취소됨',
    description: '주문이 취소되었거나 직접 입금했습니다',
    bgColor: '#F3F4F6', // gray-100
    textColor: '#374151', // gray-700
    cssClass: 'status-cancelled',
    isFinal: true,
  },
};

/**
 * 상태 코드로 메타데이터 조회
 */
export function getStatusMeta(status: OrderStatus): OrderStatusMeta {
  return ORDER_STATUS_META[status];
}

/**
 * 상태의 한글 표시명 반환
 */
export function getStatusLabel(status: OrderStatus): string {
  return ORDER_STATUS_META[status].label;
}

/**
 * 상태의 CSS 클래스명 반환
 */
export function getStatusCssClass(status: OrderStatus): string {
  return ORDER_STATUS_META[status].cssClass;
}

/**
 * 최종 상태인지 확인
 */
export function isFinalStatus(status: OrderStatus): boolean {
  return ORDER_STATUS_META[status].isFinal;
}

/**
 * 활성 상태 목록 (최종 상태가 아닌 것들)
 */
export function getActiveStatuses(): OrderStatus[] {
  return (Object.keys(ORDER_STATUS_META) as OrderStatus[]).filter(
    (status) => !ORDER_STATUS_META[status].isFinal
  );
}

/**
 * CSS 스타일 문자열 생성 (inline style용)
 */
export function getStatusStyle(status: OrderStatus): string {
  const meta = ORDER_STATUS_META[status];
  return `background: ${meta.bgColor}; color: ${meta.textColor};`;
}
