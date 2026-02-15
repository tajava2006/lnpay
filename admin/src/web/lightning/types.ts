/** 지원하는 Lightning 백엔드 구현체 */
export type LightningBackend = 'lnd' | 'cln';

/** 백엔드 공통 노드 정보 */
export interface NodeInfo {
  pubkey: string;
  alias: string;
  activeChannelsCount: number;
  peersCount: number;
  blockHeight: number;
  syncedToChain: boolean;
  version: string;
  /** 채널(Lightning) 잔고 (sats) */
  channelBalanceSat: number;
  /** 온체인(Wallet) 확정 잔고 (sats) */
  onchainBalanceSat: number;
}

/** 디코딩된 BOLT-11 인보이스 */
export interface DecodedInvoice {
  /** 수신자 노드 pubkey (hex) */
  destination: string;
  /** 금액 (sats) */
  amountSat: number;
  /** 원본 payment hash (hex) — 프로빙에서 절대 사용 금지 */
  paymentHash: string;
  /** 설명 */
  description: string;
  /** 만료 시점 (unix timestamp) */
  expiresAt: number;
  /** CLTV 만료 delta */
  cltvExpiry: number;
}

/**
 * 프로빙 결과.
 * - reachable: 경로 끝까지 도달 → 인바운드 유동성 확인
 * - unreachable: 라우팅 실패 → 유동성 부족 또는 경로 없음
 * - error: 예상 외 오류
 */
export type ProbeResult =
  | { status: 'reachable' }
  | { status: 'unreachable'; reason: string }
  | { status: 'error'; message: string };

/** 노드 연결 상태 */
export type ConnectionStatus = 'unconfigured' | 'connecting' | 'connected' | 'error';

/** useSyncExternalStore용 스냅샷 */
export interface NodeSnapshot {
  status: ConnectionStatus;
  info: NodeInfo | null;
  error: string | null;
  lastCheckedAt: number | null;
}
