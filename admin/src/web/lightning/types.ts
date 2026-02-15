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
}

/** 노드 연결 상태 */
export type ConnectionStatus = 'unconfigured' | 'connecting' | 'connected' | 'error';

/** useSyncExternalStore용 스냅샷 */
export interface NodeSnapshot {
  status: ConnectionStatus;
  info: NodeInfo | null;
  error: string | null;
  lastCheckedAt: number | null;
}
