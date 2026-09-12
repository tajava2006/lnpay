/**
 * 경량 Nostr 이벤트 빌드 + WebSocket 발행
 *
 * SimplePool 대신 직접 WebSocket을 사용하여 번들 크기를 최소화한다.
 * nostr-tools/pure의 finalizeEvent + getPublicKey만 사용.
 */
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { v2 as nip44 } from 'nostr-tools/nip44';
import {
  APP_PUBKEY,
  SAJWO_REQUEST_EVENT_KIND,
  CLIENT_TAG,
  DISCOVERY_RELAYS,
  FALLBACK_RELAYS,
} from '@sajwo-tracker/shared/constants';

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

/**
 * 이 빌드가 바라보는 Admin 신원을 hex + npub으로 돌려준다.
 *
 * 유저스크립트는 수동 설치라 상수가 바뀌어도 설치본은 옛날 값을 계속 쓴다.
 * APP_PUBKEY가 어긋나면 payment-confirm / cancel-request가 어드민 구독
 * 필터(#p=APP_PUBKEY)에 걸리지 않아 릴레이는 정상 수락하는데 아무 일도
 * 일어나지 않는다. 부팅 로그에 찍어두면 그 상황이 콘솔만 봐도 드러난다.
 */
export function describeAppPubkey(): string {
  return `${APP_PUBKEY} (${nip19.npubEncode(APP_PUBKEY)})`;
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

/** parsed-order 이벤트를 빌드하고 서명한다 (#p=ownPubkey, content NIP-44 자기암호화) */
export function buildParsedOrderEvent(
  sk: Uint8Array,
  payload: ParsedOrderPayload,
) {
  const pubkey = getPublicKey(sk);
  const expiration = Math.floor(payload.expirationDate / 1000);

  // 계좌정보가 포함되므로 NIP-44 self-encryption (자기 pubkey로 암호화)
  const conversationKey = nip44.utils.getConversationKey(sk, pubkey);
  const encrypted = nip44.encrypt(JSON.stringify(payload), conversationKey);

  return finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', pubkey],
      ['action', 'parsed-order'],
      ['t', CLIENT_TAG],
      ['expiration', String(expiration)],
    ],
    content: encrypted,
  }, sk);
}

/**
 * 쿠팡 상태 변화를 **자기 자신에게** 알린다 (입금 완료 / 취소).
 *
 * 예전에는 여기서 곧바로 payment-confirm / cancel-request를 Admin에게 발행했다.
 * 그러려면 a-태그에 sajwo orderId가, p-태그에 APP_PUBKEY가 필요했는데 둘 다 문제였다:
 *
 * - orderId 자리에 쿠팡 주문번호를 썼고, 그게 공개 태그로 나갔다(감사 A-3).
 * - APP_PUBKEY가 빌드에 박히는데, 2026-09-03 키 교체 후 설치본이 옛 키를 계속 쓰는 바람에
 *   어드민 #p 필터에 안 걸려 자동 입금감지가 6주간 조용히 죽어 있었다.
 *
 * 지금은 parsed-order와 같은 채널을 쓴다 — 수신자가 자기 자신이라 APP_PUBKEY를
 * 참조하지 않고, 쿠팡 주문번호는 암호문 안에만 남는다. 웹앱이 이걸 받아
 * 로컬 매핑으로 진짜 payment-confirm / cancel-request를 발행한다.
 */
export function buildCoupangStatusEvent(
  sk: Uint8Array,
  coupangOrderId: string,
  status: 'paid' | 'cancelled',
  expiration: number,
) {
  const pubkey = getPublicKey(sk);
  const conversationKey = nip44.utils.getConversationKey(sk, pubkey);
  const encrypted = nip44.encrypt(JSON.stringify({ coupangOrderId, status }), conversationKey);

  const tags: string[][] = [
    ['p', pubkey],
    ['action', 'coupang-status'],
    ['t', CLIENT_TAG],
  ];
  if (expiration > 0) tags.push(['expiration', String(expiration)]);

  return finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: encrypted,
  }, sk);
}
