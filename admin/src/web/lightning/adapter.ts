import type { NodeInfo } from './types';

/**
 * Lightning 노드 어댑터 인터페이스.
 *
 * Phase 1: getInfo만 구현.
 * 향후 probe, hold invoice, settle/cancel 등을 추가한다.
 */
export interface LightningAdapter {
  getInfo(): Promise<NodeInfo>;
}
