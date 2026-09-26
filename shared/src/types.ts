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

/** 데몬이 발행하는 라이트닝 오더 (데몬이 유일한 상태 소유자) */
export interface Order {
  orderId: string;
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
  /**
   * 후원자가 최종적으로 받을 금액 (sat). verified에서 Admin이 시세로 확정한다.
   * 고객의 에스크로 금액은 여기서 파생된다(ceil(payoutSat × 1.005)) — 반대가 아니다.
   * 후원자 인보이스는 이 값과 **정확히** 일치해야 받아준다.
   */
  payoutSat?: number;
  /** 검증을 통과한 후원자 인보이스 (invoiced 이후 존재). 지급 대상 */
  sponsorInvoice?: string;
  /** Sponsor에게 BTC 송금 완료 여부 */
  disbursed?: boolean;
  /** 고객 보증금 hold invoice payment hash (cancel/settle용) */
  depositPaymentHash?: string;
  /** 후원자 보증금 hold invoice payment hash (cancel/settle용) */
  sponsorDepositPaymentHash?: string;
  /**
   * `claimed`인데 후원자 보증금이 아직이다 — 진행도는 "후원자 찾는 중", 배지는 "보증금 대기".
   * 보증금이 들어오면 사라지고 `sponsorDepositPaymentHash`가 생긴다
   */
  sponsorDepositPending?: boolean;
  /**
   * 이 이벤트가 릴레이에서 사라지는 시각 (NIP-40). `expiration`(거래 마감)과 다르다 —
   * 진행 중 거래는 마감 뒤에도 이어지므로 목록에서 지울 때는 이걸 본다.
   */
  retainUntil?: number;
  /** 종결 사유 (`LnCloseReason`). 종결된 오더에만 */
  closeReason?: string;
  raw: object;
}

/** 요청 이벤트(`MESSAGE_KIND`) 공통 필드 */
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
  /**
   * 커밋먼트 솔트. 분쟁 시 계좌정보와 함께 공개해야 Admin이 대조할 수 있다.
   * 솔트 도입 이전 기록에는 없다 — 그 경우 레거시 무솔트로 검증한다.
   */
  commitmentSalt?: string;
}

/** 추가 데이터 없는 요청 */
export interface SimpleRequest extends RequestBase {
  action: 'payment-confirm' | 'cancel-request' | 'remit-request' | 'dispute-message' | 'claim-price-error'
    | 'deposit-required' | 'deposit-accepted' | 'deposit-cancelled' | 'deposit-settled'
    | 'reveal-request'
    /** 구독 정보는 content에 NIP-44로 실려 오므로 파싱된 필드가 없다 */
    | 'push-subscription';
}

/**
 * 후원자가 지급받을 인보이스 제출.
 *
 * 클레임이 아니라 **에스크로 이후**에 온다. 이 이벤트가 검증을 통과해야
 * 오더가 `invoiced`가 되고, 그래야 고객이 계좌 정보를 발행한다.
 * 규칙은 docs/LN-TRACK.md(I-009·I-010)
 */
export interface SponsorInvoiceRequest extends RequestBase {
  action: 'sponsor-invoice';
  bolt11: string;
}

/**
 * 온체인 트랙 요청은 **모양이 달라 따로 정의**돼 있다 (`./onchain/requests`).
 * 유니온은 하나로 둔다 — 파서가 한 함수라, 둘로 가르면 한쪽을 빠뜨린다.
 */
export type Request =
  | OrderRequest | ClaimRequest | AccountInfoRequest | SponsorInvoiceRequest | SimpleRequest
  | import('./onchain/requests').OnchainRequest;

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
  /**
   * 커밋먼트 솔트. 계좌정보와 함께 공개해야 Admin이 대조할 수 있다.
   * 솔트 도입 이전 기록에는 없다 — 그 경우 레거시 무솔트로 검증한다.
   */
  commitmentSalt?: string;
}

/** 복호화된 채팅 메시지 (IDB 저장용) */
export interface ChatMessage {
  eventId: string;
  orderId: string;
  senderPubkey: string;
  recipientPubkey: string;
  payload: DisputeMessagePayload;
  createdAt: number;
  /**
   * 내가 보낸 메시지의 전송 상태. 릴레이에서 받은 메시지에는 없다(이미 도달한 것이므로).
   *
   * 낙관적 렌더링 때문에 필요하다 — 보내는 즉시 화면에 띄우되, 실제로 릴레이에
   * 닿았는지를 화면이 솔직하게 말해야 한다. 이게 없으면 발행이 전부 실패해도
   * 보낸 것처럼 보인다(예전 동작).
   */
  status?: 'pending' | 'sent' | 'failed';
}

/** 캐싱된 릴레이 목록 */
export interface CachedRelayList {
  relays: string[];
  fetchedAt: number;
  /** 원본 kind 10002 이벤트의 created_at (서명 시각). 과거 이벤트 재전파 방어용. */
  createdAt: number;
}
