import type { LightningAdapter } from './adapter';
import type { LnConnectionConfig } from './types';
import type { LnConfig } from '../nostr/ln-config';
import { LndAdapter } from './lnd';
import { ClnAdapter } from './cln';

export type { LightningAdapter } from './adapter';
export type {
  LightningBackend, LnConnectionConfig, NodeInfo, ConnectionStatus, NodeSnapshot,
  DecodedInvoice, ProbeResult, HoldInvoiceResult, HoldInvoiceStatus,
} from './types';
export { createNodeTracker } from './node-tracker';
export type { NodeTracker } from './node-tracker';

/**
 * LnConfig에서 LightningAdapter를 생성한다.
 * NIP-78에서 복호화된 설정을 사용한다.
 */
export function createLightningAdapter(config: LnConfig): LightningAdapter | null {
  const connConfig: LnConnectionConfig = {
    baseUrl: config.baseUrl,
    credential: config.credential,
  };

  switch (config.backend) {
    case 'lnd':
      return new LndAdapter(connConfig);
    case 'cln':
      return new ClnAdapter(connConfig);
    default: {
      console.warn(`[Lightning] 알 수 없는 백엔드: "${config.backend as string}". Lightning 비활성.`);
      return null;
    }
  }
}
