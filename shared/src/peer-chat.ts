/**
 * 상대방 채팅 — 두 당사자만 읽는 암호문 (docs/PLAN-PEER-CHAT.md §4·§5)
 *
 * ── 키
 *
 *   K_pair  = NIP-44 대화 키(내 개인키, 상대 pubkey)            — 두 사람이 각자 계산해도 같다(a·B = b·A)
 *   K_order = HKDF-SHA256(K_pair, salt, info = v1:<트랙>:<오더>)  — 이 거래에만 묶인 키
 *
 * 메시지는 K_order로 NIP-44 v2 암호화한다. 운영자를 부르면 K_order를 넘긴다 — 운영자는 이 거래의 대화만 읽는다.
 * K_pair를 그대로 넘기지 않는 건 **개인키 때문이 아니다**(어느 쪽이든 개인키는 안 나온다). K_pair는 같은 두 사람의
 * 다른 거래 대화와 **계좌 정보**(`account-info`가 바로 K_pair로 암호화된다)까지 연다. K_order는 거래 번호를 섞어 한 번
 * 더 해시한 값이라 넘겨도 K_pair로 돌아가지 못한다.
 *
 * ── 누가 썼나
 *
 * 대칭키라 암호문만으로는 둘 중 누가 썼는지 모른다. 바깥 이벤트를 **보낸 사람의 메인 키로 서명**하고, 받는 쪽은
 * 작성자가 그 거래 당사자인 것만 연다(`openPeerMessage`). 그래서 키를 받은 운영자도 대화에 끼어들 수 없다.
 * 서명 자체는 릴레이 풀(nostr-tools)이 받을 때 검증한다.
 *
 * 순수 모듈이다 — IndexedDB·localStorage를 끌고 오지 않는다. 데몬은 가드(`isCallPayload`)만 쓴다(`/core`).
 */
import type { Event, EventTemplate } from 'nostr-tools/core';
import { v2 } from 'nostr-tools/nip44';
import { MAX_CHAT_TEXT, type TrackName } from './admin-protocol';
import { MESSAGE_KIND, REQUEST_ACTIONS } from './constants';
import { bytesToHex, hexToBytes } from './onchain/hex';
import { extractOrderId, orderRef } from './order-ref';
import type { DisputeMessagePayload } from './types';

/**
 * 상대방 채팅 이벤트의 보존 — 분쟁 때 운영자가 읽을 증거라 길게. 운영자 채팅 사본(데몬 `CHAT_COPY_RETENTION_SEC`)과 같은
 * 창이다. 운영자 채팅(dispute-message)처럼 아예 만료를 빼지는 않는다 — 부르지 않은 대화는 증거가 될 일이 없다
 */
export const PEER_CHAT_RETENTION_SEC = 90 * 24 * 60 * 60;

const KEY_SALT = 'pairbuy-peer-chat';
const keyInfo = (track: TrackName, orderId: string): string => `v1:${track}:${orderId}`;

/** 이 거래의 상대방 대화 키(32바이트). 두 당사자가 각자 계산해도 같은 값이 나온다 */
export async function derivePeerChatKey(
  mySecretKey: Uint8Array, peerPubkey: string, track: TrackName, orderId: string,
): Promise<Uint8Array> {
  const pair = new Uint8Array(v2.utils.getConversationKey(mySecretKey, peerPubkey));
  const base = await crypto.subtle.importKey('raw', pair, 'HKDF', false, ['deriveBits']);
  const text = new TextEncoder();
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: text.encode(KEY_SALT), info: text.encode(keyInfo(track, orderId)) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export const peerChatKeyHex = (key: Uint8Array): string => bytesToHex(key);

/** 운영자가 받은 키 — 모양이 틀리면 던진다(`isPeerChatKeyHex`로 먼저 거른다) */
export const peerChatKeyFromHex = (hex: string): Uint8Array => hexToBytes(hex);

export function isPeerChatKeyHex(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/** 운영자 부르기 — 사유는 비면 안 되고, 키는 있으면 모양이 맞아야 한다(상대가 아직 없을 때 부르면 키가 없다) */
export function isCallPayload(p: DisputeMessagePayload): boolean {
  return p.type === 'call'
    && typeof p.reason === 'string' && p.reason.trim() !== '' && p.reason.length <= MAX_CHAT_TEXT
    && (p.peerChatKey === undefined || isPeerChatKeyHex(p.peerChatKey));
}

/** 거래의 두 당사자 — 받은 메시지는 이 둘이 쓴 것만 연다 */
export interface PeerChatParties {
  customer: string;
  sponsor: string;
}

/** 보낼 상대방 메시지 틀. 서명은 부르는 쪽(유저 앱)이 자기 키로 한다 */
export function peerMessageTemplate(args: {
  appPubkey: string;
  trackTag: string;
  orderId: string;
  myPubkey: string;
  peerPubkey: string;
  key: Uint8Array;
  text: string;
  createdAt: number;
}): EventTemplate {
  const payload: DisputeMessagePayload = { type: 'text', content: args.text };
  return {
    kind: MESSAGE_KIND,
    created_at: args.createdAt,
    tags: [
      ['a', orderRef(args.appPubkey, args.orderId)],
      ['action', REQUEST_ACTIONS.PEER_MESSAGE],
      ['t', args.trackTag],
      ['p', args.peerPubkey],
      ['p', args.myPubkey], // 내 다른 기기도 받게
      ['p', args.appPubkey], // 데몬이 상대에게 푸시를 보내게 — 데몬은 못 연다
      ['expiration', String(args.createdAt + PEER_CHAT_RETENTION_SEC)],
    ],
    content: v2.encrypt(JSON.stringify(payload), args.key),
  };
}

/**
 * 받은 상대방 메시지를 연다 — 이 거래 · 이 트랙 · 당사자가 쓴 것 · 이 키로 풀리는 텍스트만. 아니면 null.
 * 유저 앱(자기가 계산한 키)과 어드민(공개받은 키)이 같이 쓴다.
 */
export function openPeerMessage(
  event: Pick<Event, 'kind' | 'pubkey' | 'tags' | 'content'>,
  ctx: { orderId: string; trackTag: string; parties: PeerChatParties; key: Uint8Array },
): { text: string } | null {
  if (event.kind !== MESSAGE_KIND) return null;
  const tag = (name: string) => event.tags.find(t => t[0] === name)?.[1];
  if (tag('action') !== REQUEST_ACTIONS.PEER_MESSAGE) return null;
  if (tag('t') !== ctx.trackTag) return null;
  if (extractOrderId(event.tags) !== ctx.orderId) return null;
  if (event.pubkey !== ctx.parties.customer && event.pubkey !== ctx.parties.sponsor) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(v2.decrypt(event.content, ctx.key));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== 'text' || typeof p.content !== 'string' || p.content.length > MAX_CHAT_TEXT) return null;
  return { text: p.content };
}
