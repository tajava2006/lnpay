/**
 * 온체인 모듈이 같이 쓰는 것 — 어드민 문맥에 체인·홀드 인보이스(보증금)·시드·시세·푸시를 더했다.
 */
import type { BtcNetworkName, ChainAdapter } from '@sajwo-tracker/shared/onchain';
import type { AdminContext } from '../admin/context';
import type { Holds } from '../hold';
import type { PushConfig } from '../push/send';

export interface OcContext extends AdminContext {
  /** 보증금은 LN 홀드 인보이스다 — 라이트닝과 같은 기계 */
  holds: Holds;
  chain: ChainAdapter;
  /** 배포 설정이다(운영 중에 바꾸지 않는다) — 바꾸면 이미 낸 주소가 다른 체인의 것이 된다 */
  network: BtcNetworkName;
  /** 주문별 어드민 키의 뿌리 (DM-005) */
  seed: Uint8Array;
  /** 지금 믿을 수 있는 BTC/KRW 시세. 없으면 null — 가격을 고정하지 않는다 */
  price: () => number | null;
  push: PushConfig | null;
}
