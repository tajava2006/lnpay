/** 사줘 트래커 앱 pubkey - NIP-65 릴레이 디스커버리에 사용 */
export const APP_PUBKEY = '658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5';

/** 사줘 요청 이벤트 kind (NIP-99 Classified Listing, addressable) */
export const SAJWO_REQUEST_KIND = 30402;

/** 클레임 이벤트 kind (NIP-22 Comment, 30402 리스팅에 대한 응답) */
export const SAJWO_CLAIM_KIND = 1111;

/** 클라이언트 식별 태그 (다른 30402 이벤트와 구분, dev/prod 데이터 격리) */
export const CLIENT_TAG = import.meta.env.DEV ? 'sajwo-tracker-dev' : 'sajwo-tracker';

/** 영구저장소 키 (키페어, 릴레이 캐시) */
export const STORAGE_KEYS = {
  KEYPAIR: 'nostr:keys',
  READ_RELAYS: 'nostr:read-relays',
  WRITE_RELAYS: 'nostr:write-relays',
} as const;

/** 릴레이 리스트 갱신 주기 (밀리초) */
export const RELAY_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

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
