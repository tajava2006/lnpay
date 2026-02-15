import type { LightningAdapter } from './adapter';
import type { LightningBackend } from './types';
import { LndAdapter } from './lnd';
import { ClnAdapter } from './cln';

export type { LightningAdapter } from './adapter';
export type {
  LightningBackend, NodeInfo, ConnectionStatus, NodeSnapshot,
  DecodedInvoice, ProbeResult,
} from './types';
export { createNodeTracker } from './node-tracker';
export type { NodeTracker } from './node-tracker';

/**
 * 설정된 백엔드에 맞는 LightningAdapter를 생성한다.
 * VITE_LN_BACKEND가 미설정이면 null을 반환 (Lightning 비활성).
 */
export function createLightningAdapter(): LightningAdapter | null {
  const backend = import.meta.env.VITE_LN_BACKEND as LightningBackend | undefined;

  if (!backend) return null;

  switch (backend) {
    case 'lnd':
      return new LndAdapter();
    case 'cln':
      return new ClnAdapter();
    default: {
      console.warn(`[Lightning] 알 수 없는 백엔드: "${backend as string}". Lightning 비활성.`);
      return null;
    }
  }
}
