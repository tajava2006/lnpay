/**
 * 영구저장소 어댑터 인터페이스.
 * 확장 프로그램(chrome.storage.local)과 웹앱(localStorage) 모두 지원.
 */
export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

/** Nostr 키페어 (Uint8Array는 직렬화 불가하므로 number[] 사용) */
export interface NostrKeypair {
  secretKey: number[];
  publicKey: string;
}

/** Admin이 발행하는 kind 30402 오더 (Admin이 유일한 상태 소유자) */
export interface Order {
  orderId: string;
  status: 'active' | 'sold';
  state: import('./constants').OrderState;
  customerPubkey: string;
  /** 클레임한 Sponsor의 pubkey (claimed 이후 존재) */
  sponsorPubkey?: string;
  price: number;
  createdAt: number;
  updatedAt: number;
  expiration: number;
  /** verified 전이 시 Admin이 생성한 hold invoice (Customer 결제용) */
  bolt11?: string;
  /** Sponsor에게 BTC 송금 완료 여부 */
  disbursed?: boolean;
  raw: object;
}

/** kind 1111 요청 이벤트 공통 필드 */
export interface RequestBase {
  eventId: string;
  orderId: string;
  pubkey: string;
  createdAt: number;
  expiration: number;
  raw: object;
}

// ── Lightning Invoice 타입 ─────────────────────────

export interface RouteHintHop {
  pubkey: string;
  shortChannelId: string;
  feeBaseMsat: number;
  feeProportionalMillionths: number;
  cltvExpiryDelta: number;
}

export interface DecodedBolt11 {
  destination: string;
  amountSat: number;
  paymentHash: string;
  expiresAt: number;
  routeHints: RouteHintHop[][];
}

export interface Invoice {
  bolt11: string;
  decoded: DecodedBolt11 | null;
  liquidityVerified: boolean;
}

// ── Request 디스크리미네이티드 유니온 ──────────────

/** 오더 생성 요청 (Customer/Userscript → Admin) */
export interface OrderRequest extends RequestBase {
  action: 'order-request' | 'parsed-order';
  price: number;
}

/** 클레임 요청 (Sponsor → Admin) */
export interface ClaimRequest extends RequestBase {
  action: 'claim';
  invoice: Invoice | null;
}

/** 계좌정보 전달 (Customer → Sponsor, Admin 경유) */
export interface AccountInfoRequest extends RequestBase {
  action: 'account-info';
  accountInfo?: AccountInfo;
}

/** 추가 데이터 없는 요청 */
export interface SimpleRequest extends RequestBase {
  action: 'payment-confirm' | 'cancel-request' | 'remit-request' | 'dispute-message' | 'claim-price-error';
}

export type Request = OrderRequest | ClaimRequest | AccountInfoRequest | SimpleRequest;

/** 계좌정보 (Customer → Sponsor 암호화 전달) */
export interface AccountInfo {
  bankName: string;
  accountNumber: string;
  holderName: string;
}

/** dispute-message 이벤트의 NIP-44 암호화 페이로드 */
export interface DisputeMessagePayload {
  type: 'text' | 'account-reveal';
  /** 텍스트 메시지 (type: 'text') */
  content?: string;
  /** 계좌정보 평문 제출 (type: 'account-reveal', 커밋먼트 대조 검증용) */
  accountInfo?: AccountInfo;
}

/** 복호화된 채팅 메시지 (IDB 저장용) */
export interface ChatMessage {
  eventId: string;
  orderId: string;
  senderPubkey: string;
  recipientPubkey: string;
  payload: DisputeMessagePayload;
  createdAt: number;
}

/** 캐싱된 릴레이 목록 */
export interface CachedRelayList {
  relays: string[];
  fetchedAt: number;
  /** 원본 kind 10002 이벤트의 created_at (서명 시각). 과거 이벤트 재전파 방어용. */
  createdAt: number;
}
