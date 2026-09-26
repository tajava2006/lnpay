import { LN_TERMINAL_STATES } from './ln/state-machine';

/** 페어바이 앱 pubkey (데몬) — 오더 서명자이자 NIP-65 릴레이 디스커버리의 기준 */
export const APP_PUBKEY = 'f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848';

/**
 * 오더 이벤트 kind — NIP-69 P2P 오더(주소형, `d` = 오더 id). 데몬만 발행한다.
 *
 * NIP-69 필수 태그(`nip69.ts`) 위에 우리 태그를 얹는다. 우리 앱은 우리 태그만 읽고, NIP-69 태그는 다른
 * P2P 오더 모음이 읽으라고 단다. 예전엔 NIP-99 판매글(30402)이었는데, 다른 클라이언트가 장터 글로 그렸다.
 */
export const ORDER_KIND = 38383;

/**
 * 요청·통지 이벤트 kind — 유저 → 데몬 요청, 데몬 → 유저 통지, 운영자 명령·결과·채팅 사본.
 *
 * 등록된 NIP이 없는 **우리 전용** 일반 kind다. 예전엔 NIP-22 댓글(1111)을 빌렸는데, 다른 클라이언트가
 * `p` 태그를 보고 댓글 알림으로 띄웠다(유저가 푸시를 켠 것까지 울렸다). 우리 앱 말고는 읽을 수 없는
 * 내용이라 남의 kind를 빌릴 이유가 없다. 사람이 봐야 할 일은 운영자 DM(NIP-17)으로 따로 간다.
 */
export const MESSAGE_KIND = 3838;

/**
 * 프로토콜 버전 — 데몬과 앱이 **같이 배포돼야 하는** 변경(이벤트 태그·action·내용의 모양이나 뜻)을 할 때 올린다.
 *
 * 데몬은 이 값을 운영자 상태(`AdminState.protocol`)와 오더 이벤트(`protocol` 태그)에 싣는다. 어드민은 자기 값과
 * 다르면 경고하고, 유저 앱은 자기보다 새 값을 보면 새로고침을 권한다(캐시된 옛 PWA). 둘 중 한쪽만 배포한 걸
 * 사람 기억이 아니라 화면이 말하게 하려는 것이다.
 *
 * ⚠️ kind를 바꾸는 변경은 옛 앱이 새 이벤트를 **아예 못 보므로** 여기서 못 잡는다 — 그건 배포 순서로 맞춘다.
 *
 * 1 = 2026-09-26 kind 전환(38383·3838·33838) 이후.
 */
export const PROTOCOL_VERSION = 1;

/** 이벤트에 실린 프로토콜 버전. 없거나 못 읽으면 null(버전을 싣기 전 데몬) */
export function protocolOf(tags: readonly string[][]): number | null {
  const raw = tags.find(t => t[0] === 'protocol')?.[1];
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) ? n : null;
}

/**
 * Vite가 빌드 때 채우는 환경. **데몬(Node)에는 없다** — 그때는 빈 객체라 prod 값이 된다.
 *
 * 데몬은 태그·에포크를 자기 설정에서 정하고 아래 상수에 기대지 않는다.
 * 여기서 할 일은 Node에서 이 모듈을 불러도 **터지지 않는 것**뿐이다 — `import.meta.env.DEV`를
 * 그대로 읽으면 Node에서는 `undefined.DEV`로 모듈 로드가 실패한다.
 */
const viteEnv: { DEV?: unknown; VITE_NOSTR_SINCE?: unknown } =
  (import.meta as { env?: Record<string, unknown> }).env ?? {};

/** 클라이언트 식별 태그 (트랙 구분, dev/prod 데이터 격리) */
export const CLIENT_TAG = viteEnv.DEV === true ? 'sajwo-tracker-dev' : 'sajwo-tracker';

/**
 * 온체인 트랙 전용 태그 — **라이트닝과 반드시 분리한다**.
 *
 * 이미 배포된 클라이언트가 `{ kinds:[ORDER_KIND], authors:[APP_PUBKEY], '#t':[CLIENT_TAG] }`
 * 로 돌고 있다. 온체인 오더를 같은 태그로 발행하면 **구버전 앱이 그걸 라이트닝
 * 오더로 렌더링한다.** 그 결과는 이미 봤다 — `payoutSat`이 없으면 후원자 화면에
 * "0 sat을 등록하세요"가 뜬다(2026-09-19 실측). 클레임까지 하면 어드민 FSM이
 * 모르는 오더에 요청이 쌓인다.
 *
 * `track` 태그를 달고 클라이언트에서 거르는 방법도 있지만, **모든 클라이언트가
 * 업데이트된 뒤에야** 첫 오더를 발행할 수 있다. 정적 PWA라 캐시된 구버전이
 * 언제까지 남는지 알 수 없다. 태그 분리가 유일하게 순서에 의존하지 않는 방법이다.
 */
export const CLIENT_TAG_ONCHAIN = viteEnv.DEV === true
  ? 'sajwo-tracker-onchain-dev'
  : 'sajwo-tracker-onchain';

/**
 * 운영자 명령·결과·상태 태그. 유저 트래픽과 섞이지 않게 따로 둔다.
 * 데몬은 같은 이름을 자기 설정(`LNPAY_MODE`)에서 만든다 — 둘이 어긋나면 명령이 안 닿는다.
 */
export const CLIENT_TAG_ADMIN = viteEnv.DEV === true
  ? 'sajwo-tracker-admin-dev'
  : 'sajwo-tracker-admin';

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
  typeof viteEnv.VITE_NOSTR_SINCE === 'string' && viteEnv.VITE_NOSTR_SINCE !== ''
    ? Number(viteEnv.VITE_NOSTR_SINCE)
    : undefined;

/** 요청·통지 이벤트(`MESSAGE_KIND`)의 action 태그 값 */
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

  // ── 온체인 트랙 ──
  // 라이트닝과 같은 kind·같은 배관을 쓰고 action 값만 다르다.
  /** 고객 → Admin: 온체인 의뢰 등록 */
  ONCHAIN_ORDER_REQUEST: 'onchain-order-request',
  /** 후원자 → Admin: 클레임 (받을 주소·feerate는 암호문) */
  ONCHAIN_CLAIM: 'onchain-claim',
  /** 후원자 → Admin: 사전서명된 릴리스 PSBT (암호문) */
  ONCHAIN_PRESIG: 'onchain-presig',
  /** 고객 → Admin: 최종 서명 — 릴리스·환불·고객승 분쟁 공용 (암호문) */
  ONCHAIN_COSIGN: 'onchain-cosign',
  /** 양쪽 → Admin: 분쟁 제기 / 계좌 이의 증거 */
  ONCHAIN_DISPUTE: 'onchain-dispute',
  /**
   * Admin → 유저: 요청을 처리할 수 없다 (사유 포함).
   *
   * 없으면 거절이 **콘솔 로그로만** 남아 유저 쪽에는 아무 일도 안 일어난 것처럼
   * 보인다 — 의뢰가 조용히 사라진다(2026-09-21 실측).
   */
  ONCHAIN_REJECTED: 'onchain-rejected',
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
  /**
   * 쿠팡 가상계좌 기한(`deadline`)이 지나 원화가 더는 갈 수 없어 데몬이 닫았다.
   * `remitted` 전까지만 온다 — 그 뒤는 분쟁 판정으로 끝난다.
   */
  EXPIRED: 'expired',
} as const;
export type OrderState = typeof ORDER_STATES[keyof typeof ORDER_STATES];

/**
 * 라이트닝 오더의 종결 상태 — 전이 맵에서 유도한다(나가는 전이가 없는 상태).
 *
 * 손으로 나열한 목록은 반드시 갈라진다 — 이 목록이 다섯 군데에 복붙돼 있을 때 `admin_closed`를 넣으며 둘만
 * 고쳐 종결된 의뢰가 오더북에 계속 떠 있었다(2026-09-19).
 */
export const TERMINAL_STATES: ReadonlySet<OrderState> = LN_TERMINAL_STATES;

export function isTerminalState(state: OrderState | undefined): boolean {
  return state !== undefined && TERMINAL_STATES.has(state);
}

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
 * 유저가 알림을 다시 켜야 살아난다. 개인키는 데몬 비밀 파일(`vapid.key`)에만 있다.
 */
export const VAPID_PUBLIC_KEY =
  'BPQARlaUd2GNRFgRCSOR0orzzEABonRXfsfK627qvJzSD6pUdveRLeWbGLlgjky17upvBO8jnuce2JN-5HTKUNk';
