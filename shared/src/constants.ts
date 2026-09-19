/** 페어바이 앱 pubkey - NIP-65 릴레이 디스커버리에 사용 */
export const APP_PUBKEY = 'f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848';

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
 * 통합 앱(고객+후원자)의 IndexedDB 이름.
 *
 * 이름은 역사적 잔재다. 두 앱을 합칠 때 고객앱 DB를 그대로 승계했는데,
 * 거기 만료 없는 분쟁 채팅(증거)이 쌓여 있어 이름을 바꾸면 복사
 * 마이그레이션을 쓰거나 버려야 했기 때문이다. 이름값 하나 때문에
 * 마이그레이션을 도입할 이유가 없어 그대로 둔다.
 */
export const ORDER_DB_NAME = 'customer-history';

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
  ACCOUNT_INFO: 'account-info',
  REMIT_REQUEST: 'remit-request',
  PARSED_ORDER: 'parsed-order',
  DISPUTE_MESSAGE: 'dispute-message',
  CLAIM_PRICE_ERROR: 'claim-price-error',
  DEPOSIT_REQUIRED: 'deposit-required',
  DEPOSIT_ACCEPTED: 'deposit-accepted',
  DEPOSIT_CANCELLED: 'deposit-cancelled',
  DEPOSIT_SETTLED: 'deposit-settled',
  /** 유저스크립트 → 자기 웹앱: 쿠팡 입금/취소 감지 알림 (자기암호화) */
  COUPANG_STATUS: 'coupang-status',
  /** Admin → 후원자: 분쟁 중재를 위해 받은 계좌정보를 공개해 달라는 요청 */
  REVEAL_REQUEST: 'reveal-request',
  /** 유저 → Admin: Web Push 구독 정보 등록 (NIP-44 암호화) */
  PUSH_SUBSCRIPTION: 'push-subscription',
  /** 후원자 → Admin: 지급받을 인보이스 제출 (escrowed 이후) */
  SPONSOR_INVOICE: 'sponsor-invoice',
} as const;
export type RequestAction = typeof REQUEST_ACTIONS[keyof typeof REQUEST_ACTIONS];

/** Admin FSM 오더 상태 */
export const ORDER_STATES = {
  REQUESTED: 'requested',
  CLAIMED: 'claimed',
  VERIFIED: 'verified',
  ESCROWED: 'escrowed',
  /** 후원자 인보이스가 검증됨. 이 상태부터 고객이 계좌 정보를 발행한다 */
  INVOICED: 'invoiced',
  REMITTED: 'remitted',
  PAID: 'paid',
  CANCELLED: 'cancelled',
  SPONSOR_WINS: 'sponsor_wins',
  CUSTOMER_WINS: 'customer_wins',
  /**
   * 어드민 강제 종결. 방치된 거래를 정리하고 에스크로를 환불한다.
   *
   * `cancelled`와 따로 두는 이유: 취소는 거래가 시작되기 전의 정상적인 이탈이고
   * 고객이 스스로 할 수 있다. 이건 **에스크로가 잡힌 뒤** 아무도 움직이지 않아
   * 어드민이 손으로 끊는 것이라 성격이 다르다. 같은 상태로 뭉치면 나중에
   * "왜 취소됐지"를 구분할 수 없다.
   */
  ADMIN_CLOSED: 'admin_closed',
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

/**
 * Web Push VAPID 공개키 (P-256 uncompressed, base64url)
 *
 * 유저가 구독할 때 `applicationServerKey`로 쓰고, 어드민이 보낼 때 같은 키쌍의
 * 개인키로 JWT를 서명한다. 푸시 서비스가 그 서명을 이 공개키로 검증해서
 * "우리가 보낸 게 맞다"를 확인한다 — 남이 우리 구독자에게 못 쏘게 하는 장치다.
 *
 * ⚠️ 이 값을 바꾸면 **기존 구독이 전부 무효**가 된다. 구독은 발급 시점의
 * applicationServerKey에 묶여서, 키가 달라지면 푸시 서비스가 403으로 거절한다.
 * 유저가 알림을 다시 켜야 살아난다. 개인키는 어드민 설정에만 있고 여기 없다.
 */
export const VAPID_PUBLIC_KEY =
  'BPQARlaUd2GNRFgRCSOR0orzzEABonRXfsfK627qvJzSD6pUdveRLeWbGLlgjky17upvBO8jnuce2JN-5HTKUNk';

/**
 * NIP-17 DM 알림을 쓸지.
 *
 * 2026-09-17 off. Web Push가 크롬·브레이브·파이어폭스·안드로이드까지 다 커버하게
 * 되면서 이 경로를 안내할 이유가 없어졌고, 안내를 감춘 채로 계속 발송하면 아무도
 * 안 여는 gift wrap이 릴레이에 쌓이기만 한다(계정 단위라 만료 태그도 없다).
 *
 * 이 스위치 하나가 세 곳을 함께 끈다:
 *   - 유저 신원 발행 (kind 0 + 10002) — NIP-17 인박스 탐색 전용이라 같이 무의미
 *   - 어드민 DM 발송 (kind 1059)
 *   - 🔔 모달의 nostr 안내 섹션
 *
 * 코드는 남긴다. 브라우저 정책이 바뀌거나 푸시 서비스가 막히면 유일한 대안이 된다.
 */
export const NOSTR_DM_NOTIFICATIONS = false;
