/**
 * 라이트닝 모듈이 같이 쓰는 것 — 어드민 문맥에 노드·시드·시세·푸시를 더했다.
 */
import type { AdminContext } from '../admin/context';
import type { Holds } from '../hold';
import type { PushConfig } from '../push/send';
import type { LnNode } from './lnd';

export interface LnContext extends AdminContext {
  node: LnNode;
  seed: Uint8Array;
  /** 홀드 인보이스 — 온체인 보증금과 같이 쓴다 */
  holds: Holds;
  /** 지금 믿을 수 있는 BTC/KRW 시세. 오래됐거나 거래소가 모자라면 null — 금액을 정하지 않는다 */
  price: () => number | null;
  /** 없으면 웹 푸시를 보내지 않는다 */
  push: PushConfig | null;
}
