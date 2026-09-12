// Types
export type { StorageAdapter, NostrKeypair, CachedRelayList, Order, AccountInfo, DisputeMessagePayload, ChatMessage } from './types';
export type { RequestBase, RouteHintHop, DecodedBolt11, Invoice, OrderRequest, ClaimRequest, AccountInfoRequest, SimpleRequest, Request } from './types';

// Constants
export {
  APP_PUBKEY,
  SAJWO_REQUEST_KIND,
  SAJWO_REQUEST_EVENT_KIND,
  CLIENT_TAG,
  STORAGE_KEYS,
  ORDER_DB_NAME,
  DISCOVERY_RELAYS,
  FALLBACK_RELAYS,
  NOSTR_SINCE,
  REQUEST_ACTIONS,
  ORDER_STATES,
} from './constants';
export type { RequestAction, OrderState } from './constants';

// Storage adapters
export { createWebStorage, storage } from './storage';

// Keys
export { ensureKeypair, getSecretKey, getUserPubkey } from './keys';

// Relays
export { subscribeRelayLists, getReadRelays, getWriteRelays, refreshRelayLists } from './relays';

// Crypto (NIP-44)
export { nip44Encrypt, nip44Decrypt, sha256Hex } from './crypto';

// Price
export { createPriceTracker } from './price';
export type { PriceTracker, PriceSnapshot, ExchangeState } from './price';

// IDB (공통 IndexedDB)
export {
  initIdb,
  idbGetOrder, idbHasOrder, idbUpsertOrder,
  idbUpsertRequest, idbGetRequestsByOrderId,
  idbUpsertMessage, idbGetMessagesByOrderId,
  idbGetOrdersPage,
  idbMigrateOrderWithRequests,
} from './idb';

// 분쟁 채팅 on-demand 구독 (고객·후원자 공용)
export { subscribeChatMessages } from './chat-subscribe';

// Dispute Message (공통 처리)
export { extractOrderId, processDisputeEvent } from './dispute-message';
export type { DisputeEvent } from './dispute-message';

// Components
export { BtcPrice } from './components/BtcPrice';
export { KeyInit } from './components/KeyInit';
export { ChatWindow } from './components/ChatWindow';
export { InvoicePayBlock } from './components/InvoicePayBlock';
export { OrderProgress } from './components/OrderProgress';

// 거래 진행도 (고객·후원자 공용 단계 모델)
export { PROGRESS_STEPS, resolveProgress, stepActor } from './order-progress';
export type {
  ProgressRole, StepStatus, StepActor, StepAction,
  ProgressStep, ProgressContext, ResolvedStep, Progress, TerminalInfo,
} from './order-progress';

// 후원자-오더 관계 판정
export { sponsorRelation } from './sponsor-relation';
export type { SponsorRelation } from './sponsor-relation';

// 구독 생명주기 가드
export { createSubscriptionGuard } from './subscription-guard';
export type { SubscriptionGuard } from './subscription-guard';

// Chat Store (리액티브 인메모리 채팅)
export { subscribeChatStore, getChatSnapshot, addMessage, loadFromIdb, clearMessages } from './chat-store';
