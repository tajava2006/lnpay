/**
 * 런타임 무관한 코어
 *
 * 데몬(Node)이 가져다 쓰는 입구다. **여기서 내보내는 것은 브라우저·Vite·React에 기대지 않는다** —
 * localStorage·IndexedDB·컴포넌트는 `@sajwo-tracker/shared` 루트에만 있다. 루트를 데몬에서 부르면
 * React까지 딸려 오고, 저장소 모듈이 로드 시점에 `localStorage`를 찾는다.
 */
export {
  APP_PUBKEY,
  PROTOCOL_VERSION,
  protocolOf,
  ORDER_KIND,
  MESSAGE_KIND,
  CLIENT_TAG,
  CLIENT_TAG_ONCHAIN,
  CLIENT_TAG_ADMIN,
  DISCOVERY_RELAYS,
  FALLBACK_RELAYS,
  VAPID_PUBLIC_KEY,
  REQUEST_ACTIONS,
  ORDER_STATES,
  TERMINAL_STATES,
  isTerminalState,
} from './constants';
export type { RequestAction, OrderState } from './constants';

export { nip44Encrypt, nip44Decrypt } from './crypto';

export {
  ADMIN_ACTIONS, ADMIN_COMMAND_TTL_SEC, ADMIN_STATE_KIND, ADMIN_STATE_STALE_SEC, DEFAULT_SETTINGS,
  MAX_CHAT_TEXT, MAX_DEPOSIT_PCT, adminOrderDTag, adminOrderDTagPrefix, adminStateDTag, applySettingsPatch,
} from './admin-protocol';
export type {
  AdminAlert, AdminChatCopy, AdminCommand, AdminCommandResult, AdminLnInvoice, AdminLnInvoicePurpose,
  AdminLnOrderDetail, AdminOcBond, AdminOcOrderDetail, AdminOcUtxo, AdminState, DaemonSettings, OrderTarget, TrackName,
} from './admin-protocol';
export type { DisputeMessagePayload, AccountInfo } from './types';
export { extractOrderId, orderRef } from './order-ref';
export { orderLink } from './nip69';

export { createPriceTracker, freshPrice } from './price';
export type { PriceTracker, PriceSnapshot } from './price';
