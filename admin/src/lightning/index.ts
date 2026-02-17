import type { LightningAdapter } from './adapter';
import type { LightningBackend, LnConnectionConfig } from './types';
import { LndAdapter } from './lnd';
import { ClnAdapter } from './cln';

export type { LightningAdapter } from './adapter';
export type {
  LightningBackend, LnConnectionConfig, NodeInfo, ConnectionStatus, NodeSnapshot,
  DecodedInvoice, ProbeResult,
} from './types';
export { createNodeTracker } from './node-tracker';
export type { NodeTracker } from './node-tracker';

/**
 * 설정된 백엔드에 맞는 LightningAdapter를 생성한다.
 *
 * 현재는 VITE_ 환경변수에서 설정을 읽는다.
 * 향후 NIP-46 인증 + 릴레이 암호화 저장소에서 읽는 방식으로 교체 예정.
 */
export function createLightningAdapter(): LightningAdapter | null {
  const backend = import.meta.env.VITE_LN_BACKEND as LightningBackend | undefined;
  const baseUrl = import.meta.env.VITE_LN_REST_HOST as string | undefined;
  const credential = import.meta.env.VITE_LN_CREDENTIAL as string | undefined;

  if (!backend || !baseUrl || !credential) return null;

  const config: LnConnectionConfig = { baseUrl, credential };

  switch (backend) {
    case 'lnd':
      return new LndAdapter(config);
    case 'cln':
      return new ClnAdapter(config);
    default: {
      console.warn(`[Lightning] 알 수 없는 백엔드: "${backend as string}". Lightning 비활성.`);
      return null;
    }
  }
}
