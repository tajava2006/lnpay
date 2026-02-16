/**
 * 주문 상태별 메타데이터
 *
 * 상태의 표시명, 색상 등을 중앙에서 관리.
 * UI 컴포넌트에서는 이 메타데이터를 참조하여 일관된 표시.
 */

import type { SponsorOrderStatus } from './types';

export interface SponsorStatusMeta {
  /** 상태 코드 */
  code: SponsorOrderStatus;
  /** 한글 표시명 */
  label: string;
  /** 배경색 */
  bgColor: string;
  /** 텍스트색 */
  textColor: string;
  /** 최종 상태 여부 (더 이상 전이 불가) */
  isFinal: boolean;
}

export const SPONSOR_STATUS_META: Record<SponsorOrderStatus, SponsorStatusMeta> = {
  detected: {
    code: 'detected',
    label: '주문 발견',
    bgColor: '#E0E7FF', // indigo-100
    textColor: '#3730A3', // indigo-800
    isFinal: false,
  },
  claimed: {
    code: 'claimed',
    label: '클레임 완료',
    bgColor: '#DBEAFE', // blue-100
    textColor: '#1E40AF', // blue-800
    isFinal: false,
  },
  approved: {
    code: 'approved',
    label: '승인됨',
    bgColor: '#D1FAE5', // green-100
    textColor: '#065F46', // green-800
    isFinal: false,
  },
  rejected: {
    code: 'rejected',
    label: '거절됨',
    bgColor: '#FEE2E2', // red-100
    textColor: '#991B1B', // red-800
    isFinal: false,
  },
  selected: {
    code: 'selected',
    label: '선택됨',
    bgColor: '#FEF3C7', // amber-100
    textColor: '#92400E', // amber-800
    isFinal: false,
  },
  completed: {
    code: 'completed',
    label: '거래 완료',
    bgColor: '#D1FAE5', // green-100
    textColor: '#065F46', // green-800
    isFinal: true,
  },
};

/** 상태 코드로 메타데이터 조회 */
export function getStatusMeta(status: SponsorOrderStatus): SponsorStatusMeta {
  return SPONSOR_STATUS_META[status];
}

/** 최종 상태인지 확인 */
export function isFinalStatus(status: SponsorOrderStatus): boolean {
  return SPONSOR_STATUS_META[status].isFinal;
}
