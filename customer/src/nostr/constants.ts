/** 사줘 트래커 앱 pubkey - NIP-65 릴레이 디스커버리에 사용 */
export const APP_PUBKEY = '658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5';

/** 사줘 요청 이벤트 kind (NIP-78 Application-specific data, addressable) */
export const SAJWO_REQUEST_KIND = 30078;

/** chrome.storage.local 키 */
export const STORAGE_KEYS = {
  KEYPAIR: 'nostr:keys',
  RELAYS: 'nostr:relays',
} as const;

/** 릴레이 리스트 갱신 주기 (분) */
export const RELAY_REFRESH_INTERVAL_MINUTES = 10;

/** chrome.alarms 이름 */
export const RELAY_REFRESH_ALARM = 'nostr:relay-refresh';

/** NIP-65 디스커버리용 well-known 릴레이 (앱 pubkey의 kind 10002를 찾기 위해 사용) */
export const DISCOVERY_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
];

/** NIP-65 디스커버리 실패 시 폴백 릴레이 */
export const FALLBACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];
