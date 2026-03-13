/**
 * 주문 표시 상태 메타데이터
 *
 * Admin의 OrderState + raw 필드 존재 여부로 Customer UI 표시 상태를 결정.
 * Admin이 상태 소유자이므로 adminState가 있으면 그대로 표시하고,
 * 없으면 raw 필드로 "주문 생성"(미발행) vs "요청 대기"(발행됨)를 구분한다.
 */

import type { OrderState } from '@sajwo-tracker/shared';
import type { CustomerOrder } from './types';

export interface DisplayMeta {
  /** 한글 표시명 */
  label: string;
  /** 배경색 */
  bgColor: string;
  /** 텍스트색 */
  textColor: string;
  /** 최종 상태 여부 */
  isFinal: boolean;
}

/** Admin OrderState별 표시 메타 */
const ADMIN_STATE_META: Record<OrderState, DisplayMeta> = {
  requested: {
    label: '요청됨',
    bgColor: '#FEF3C7',
    textColor: '#D97706',
    isFinal: false,
  },
  claimed: {
    label: '클레임 접수',
    bgColor: '#DBEAFE',
    textColor: '#1E40AF',
    isFinal: false,
  },
  verified: {
    label: '결제 대기',
    bgColor: '#FEE2E2',
    textColor: '#DC2626',
    isFinal: false,
  },
  escrowed: {
    label: '에스크로',
    bgColor: '#EDE9FE',
    textColor: '#7C3AED',
    isFinal: false,
  },
  remitted: {
    label: '송금 확인 대기',
    bgColor: '#FCE7F3',
    textColor: '#BE185D',
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
  sponsor_wins: {
    label: '후원자 승리',
    bgColor: '#CCFBF1',
    textColor: '#0F766E',
    isFinal: true,
  },
  customer_wins: {
    label: '환불 완료',
    bgColor: '#CFFAFE',
    textColor: '#0E7490',
    isFinal: true,
  },
};

/** 주문 생성됨 (미발행) */
const CREATED_META: DisplayMeta = {
  label: '주문 생성',
  bgColor: '#E0E7FF',
  textColor: '#3730A3',
  isFinal: false,
};

/** 요청 전송됨 (Admin 응답 대기) */
const PENDING_META: DisplayMeta = {
  label: '요청 대기',
  bgColor: '#FEF9C3',
  textColor: '#A16207',
  isFinal: false,
};

/**
 * 주문의 표시 메타데이터를 반환한다.
 *
 * 우선순위: adminState > raw 존재 여부
 */
export function getDisplayMeta(order: CustomerOrder): DisplayMeta {
  if (order.adminState) {
    return ADMIN_STATE_META[order.adminState];
  }
  return order.raw ? PENDING_META : CREATED_META;
}

/**
 * 최종 상태인지 확인
 */
export function isFinal(order: CustomerOrder): boolean {
  return getDisplayMeta(order).isFinal;
}

/**
 * 삭제 불가: 상대방이 관여된 거래 진행 중 (claimed, verified, escrowed, remitted)
 */
const UNDELETABLE_STATES: ReadonlySet<OrderState> = new Set(['claimed', 'verified', 'escrowed', 'remitted']);

/**
 * 주문 삭제 가능 여부 확인
 */
export function isDeletable(order: CustomerOrder): boolean {
  if (!order.adminState) return true;
  return !UNDELETABLE_STATES.has(order.adminState);
}

/**
 * 취소 가능: 에스크로 전 (돈이 오가기 전) 상태
 */
const CANCELLABLE_STATES: ReadonlySet<OrderState> = new Set(['requested', 'claimed', 'verified']);

/**
 * 주문 취소 요청 가능 여부 확인
 */
export function isCancellable(order: CustomerOrder): boolean {
  if (!order.adminState) return false; // Admin에 등록되지 않은 주문은 삭제로 처리
  return CANCELLABLE_STATES.has(order.adminState);
}
