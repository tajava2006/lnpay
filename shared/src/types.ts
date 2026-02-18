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

/** 캐싱된 릴레이 목록 */
export interface CachedRelayList {
  relays: string[];
  fetchedAt: number;
  /** 원본 kind 10002 이벤트의 created_at (서명 시각). 과거 이벤트 재전파 방어용. */
  createdAt: number;
}
