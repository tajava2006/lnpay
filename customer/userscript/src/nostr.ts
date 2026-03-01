/**
 * 경량 Nostr 이벤트 빌드 + WebSocket 발행
 *
 * SimplePool 대신 직접 WebSocket을 사용하여 번들 크기를 최소화한다.
 * nostr-tools/pure의 finalizeEvent + getPublicKey만 사용.
 */
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

/** 앱 pubkey (shared/constants.ts와 동일) */
const APP_PUBKEY = '658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5';

/** NIP-22 Comment kind */
const KIND_1111 = 1111;

/** kind 30402 (NIP-99 Classified Listing) */
const KIND_30402 = 30402;

/** 클라이언트 식별 태그 */
const CLIENT_TAG = 'sajwo-tracker';

/** NIP-65 디스커버리용 릴레이 */
const DISCOVERY_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

const FALLBACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
];

// ── nsec 디코딩 ─────────────────────────────────────

export function decodeNsec(nsec: string): Uint8Array {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== 'nsec') {
    throw new Error('올바른 nsec 형식이 아닙니다');
  }
  return decoded.data;
}

export function getPubkeyFromSecret(sk: Uint8Array): string {
  return getPublicKey(sk);
}

// ── 릴레이 디스커버리 ────────────────────────────────

/** NIP-65 kind 10002 이벤트에서 읽기 릴레이 추출 (one-shot) */
export async function discoverRelays(): Promise<string[]> {
  for (const relay of DISCOVERY_RELAYS) {
    try {
      const relays = await fetchRelayList(relay);
      if (relays.length > 0) return relays;
    } catch {
      // 다음 릴레이 시도
    }
  }
  return FALLBACK_RELAYS;
}

function fetchRelayList(relayUrl: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const subId = 'relay-discovery';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error('timeout'));
      }
    }, 5000);

    ws.onopen = () => {
      ws.send(JSON.stringify([
        'REQ', subId,
        { kinds: [10002], authors: [APP_PUBKEY], limit: 1 },
      ]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data as string) as unknown[];
        if (data[0] === 'EVENT' && data[1] === subId) {
          const event = data[2] as { tags: string[][] };
          const readRelays = event.tags
            .filter((t: string[]) => t[0] === 'r' && (!t[2] || t[2] === 'read'))
            .map((t: string[]) => t[1]);

          if (readRelays.length > 0 && !resolved) {
            resolved = true;
            clearTimeout(timer);
            ws.send(JSON.stringify(['CLOSE', subId]));
            ws.close();
            resolve(readRelays);
          }
        } else if (data[0] === 'EOSE' && !resolved) {
          resolved = true;
          clearTimeout(timer);
          ws.close();
          resolve([]);
        }
      } catch {
        // 파싱 실패 무시
      }
    };

    ws.onerror = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error('ws error'));
      }
    };
  });
}

// ── 이벤트 발행 ──────────────────────────────────────

interface PublishResult {
  success: boolean;
  publishedTo: string[];
}

/** 서명된 이벤트를 릴레이 목록에 발행한다 */
export async function publishToRelays(
  signed: ReturnType<typeof finalizeEvent>,
  relays: string[],
): Promise<PublishResult> {
  const publishedTo: string[] = [];

  const results = await Promise.allSettled(
    relays.map(relay => publishToRelay(signed, relay)),
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      publishedTo.push(relays[i]);
    }
  }

  return { success: publishedTo.length > 0, publishedTo };
}

function publishToRelay(
  signed: ReturnType<typeof finalizeEvent>,
  relayUrl: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        ws.close();
        reject(new Error('publish timeout'));
      }
    }, 5000);

    ws.onopen = () => {
      ws.send(JSON.stringify(['EVENT', signed]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data as string) as unknown[];
        if (data[0] === 'OK' && data[1] === signed.id && !done) {
          done = true;
          clearTimeout(timer);
          ws.close();
          if (data[2]) {
            resolve();
          } else {
            reject(new Error(String(data[3] ?? 'rejected')));
          }
        }
      } catch {
        // 파싱 실패 무시
      }
    };

    ws.onerror = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error('ws error'));
      }
    };
  });
}

// ── 이벤트 빌더 ──────────────────────────────────────

interface ParsedOrderPayload {
  coupangOrderId: string;
  productName: string;
  price: number;
  bankName: string;
  accountNumber: string;
  depositor: string;
  expirationDate: number;
}

/** parsed-order 이벤트를 빌드하고 서명한다 (#p=ownPubkey) */
export function buildParsedOrderEvent(
  sk: Uint8Array,
  payload: ParsedOrderPayload,
) {
  const pubkey = getPublicKey(sk);
  const expiration = Math.floor(payload.expirationDate / 1000);

  return finalizeEvent({
    kind: KIND_1111,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', pubkey],
      ['action', 'parsed-order'],
      ['t', CLIENT_TAG],
      ['expiration', String(expiration)],
    ],
    content: JSON.stringify(payload),
  }, sk);
}

/** payment-confirm 이벤트를 빌드하고 서명한다 (#p=APP_PUBKEY) */
export function buildPaymentConfirmEvent(sk: Uint8Array, orderId: string) {
  return finalizeEvent({
    kind: KIND_1111,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['a', `${KIND_30402}:${APP_PUBKEY}:${orderId}`],
      ['action', 'payment-confirm'],
      ['t', CLIENT_TAG],
      ['p', APP_PUBKEY],
    ],
    content: '',
  }, sk);
}

/** cancel-request 이벤트를 빌드하고 서명한다 (#p=APP_PUBKEY) */
export function buildCancelRequestEvent(sk: Uint8Array, orderId: string) {
  return finalizeEvent({
    kind: KIND_1111,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['a', `${KIND_30402}:${APP_PUBKEY}:${orderId}`],
      ['action', 'cancel-request'],
      ['t', CLIENT_TAG],
      ['p', APP_PUBKEY],
    ],
    content: '',
  }, sk);
}
