/** 사줘 트래커 앱 pubkey - NIP-65 릴레이 디스커버리에 사용 */
export const APP_PUBKEY = '658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5';

/** 사줘 요청 이벤트 kind (NIP-99 Classified Listing, addressable) */
export const SAJWO_REQUEST_KIND = 30402;

/** 요청 이벤트 kind (NIP-22 Comment, Customer/Sponsor → Admin 요청) */
export const SAJWO_REQUEST_EVENT_KIND = 1111;

/** 클라이언트 식별 태그 (다른 30402 이벤트와 구분, dev/prod 데이터 격리) */
export const CLIENT_TAG = import.meta.env.DEV ? 'sajwo-tracker-dev' : 'sajwo-tracker';

/** 영구저장소 키 (키페어, 릴레이 캐시) */
export const STORAGE_KEYS = {
  KEYPAIR: 'nostr:keys',
  READ_RELAYS: 'nostr:read-relays',
  WRITE_RELAYS: 'nostr:write-relays',
} as const;

/**
 * Nostr 구독 since 필터 (테스트 중 데이터 격리용, 임시).
 * .env의 VITE_NOSTR_SINCE에 Unix 타임스탬프를 설정하면
 * 해당 시각 이후 이벤트만 구독한다. 미설정 시 필터 없음.
 */
export const NOSTR_SINCE: number | undefined =
  import.meta.env.VITE_NOSTR_SINCE
    ? Number(import.meta.env.VITE_NOSTR_SINCE)
    : undefined;

/** kind 1111 request의 action 태그 값 */
export const REQUEST_ACTIONS = {
  ORDER_REQUEST: 'order-request',
  CLAIM: 'claim',
  PAYMENT_CONFIRM: 'payment-confirm',
  CANCEL_REQUEST: 'cancel-request',
} as const;
export type RequestAction = typeof REQUEST_ACTIONS[keyof typeof REQUEST_ACTIONS];

/** Admin FSM 오더 상태 */
export const ORDER_STATES = {
  REQUESTED: 'requested',
  CLAIMED: 'claimed',
  VERIFIED: 'verified',
  ESCROWED: 'escrowed',
  REMITTED: 'remitted',
  PAID: 'paid',
  CANCELLED: 'cancelled',
  SPONSOR_WINS: 'sponsor_wins',
  CUSTOMER_WINS: 'customer_wins',
} as const;
export type OrderState = typeof ORDER_STATES[keyof typeof ORDER_STATES];

/** NIP-65 디스커버리용 well-known 릴레이 */
export const DISCOVERY_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

/** NIP-65 디스커버리 실패 시 폴백 릴레이 */
export const FALLBACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
];
