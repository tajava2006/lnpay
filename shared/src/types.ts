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

/** kind 1111 요청 이벤트 (Customer/Sponsor → Admin) */
export interface AdminRequest {
  eventId: string;
  orderId: string;
  action: import('./constants').RequestAction;
  pubkey: string;
  createdAt: number;
  expiration: number;
  raw: object;
}

/** 캐싱된 릴레이 목록 */
export interface CachedRelayList {
  relays: string[];
  fetchedAt: number;
  /** 원본 kind 10002 이벤트의 created_at (서명 시각). 과거 이벤트 재전파 방어용. */
  createdAt: number;
}
