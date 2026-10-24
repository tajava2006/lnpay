/**
 * 상대방 채팅 키·암호문 (docs/PLAN-PEER-CHAT.md §4)
 *
 * 지켜야 할 것: 두 사람이 **주고받는 과정 없이** 같은 키를 얻는다 · 그 키는 이 거래에만 묶인다(운영자에게 넘겨도 다른
 * 거래 대화나 계좌 정보가 안 열린다) · 받는 쪽은 당사자가 쓴 것만 연다(키를 받은 운영자도 끼어들 수 없다).
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { v2 } from 'nostr-tools/nip44';
import {
  PEER_CHAT_RETENTION_SEC, derivePeerChatKey, isCallPayload, isPeerChatKeyHex, openPeerMessage, peerChatKeyFromHex,
  peerChatKeyHex, peerMessageTemplate,
} from '../peer-chat';
import { REQUEST_ACTIONS } from '../constants';
import { nip44Encrypt } from '../crypto';

const app = generateSecretKey();
const APP = getPublicKey(app);
const customerSk = generateSecretKey();
const sponsorSk = generateSecretKey();
const CUSTOMER = getPublicKey(customerSk);
const SPONSOR = getPublicKey(sponsorSk);
const parties = { customer: CUSTOMER, sponsor: SPONSOR };
const TAG = 'sajwo-tracker';
const NOW = 1_800_000_000;

async function send(fromSk: Uint8Array, toPubkey: string, text: string, orderId = 'o1', track: 'ln' | 'onchain' = 'ln') {
  const key = await derivePeerChatKey(fromSk, toPubkey, track, orderId);
  return finalizeEvent(peerMessageTemplate({
    appPubkey: APP, trackTag: TAG, orderId, myPubkey: getPublicKey(fromSk), peerPubkey: toPubkey, key, text, createdAt: NOW,
  }), fromSk);
}

describe('대화 키', () => {
  it('두 당사자가 각자 계산해도 같다', async () => {
    const a = await derivePeerChatKey(customerSk, SPONSOR, 'ln', 'o1');
    const b = await derivePeerChatKey(sponsorSk, CUSTOMER, 'ln', 'o1');
    expect(peerChatKeyHex(a)).toBe(peerChatKeyHex(b));
    expect(a).toHaveLength(32);
  });

  it('거래·트랙·상대가 다르면 다른 키', async () => {
    const base = peerChatKeyHex(await derivePeerChatKey(customerSk, SPONSOR, 'ln', 'o1'));
    expect(peerChatKeyHex(await derivePeerChatKey(customerSk, SPONSOR, 'ln', 'o2'))).not.toBe(base);
    expect(peerChatKeyHex(await derivePeerChatKey(customerSk, SPONSOR, 'onchain', 'o1'))).not.toBe(base);
    expect(peerChatKeyHex(await derivePeerChatKey(customerSk, getPublicKey(generateSecretKey()), 'ln', 'o1'))).not.toBe(base);
  });

  /** 넘기는 건 K_order다 — K_pair가 아니다. K_pair면 계좌 정보(account-info)까지 열린다 */
  it('두 사람 NIP-44 대화 키(K_pair)와 다르고, 계좌 정보는 거래 키로 안 열린다', async () => {
    const pair = v2.utils.getConversationKey(customerSk, SPONSOR);
    const order = await derivePeerChatKey(customerSk, SPONSOR, 'ln', 'o1');
    expect(peerChatKeyHex(order)).not.toBe(peerChatKeyHex(pair));

    const accountInfo = nip44Encrypt(JSON.stringify({ accountNumber: '123' }), customerSk, SPONSOR); // publishAccountInfo와 같은 방식
    expect(() => v2.decrypt(accountInfo, order)).toThrow();
  });

  it('hex로 넘기고 되돌린다', async () => {
    const key = await derivePeerChatKey(customerSk, SPONSOR, 'ln', 'o1');
    const hex = peerChatKeyHex(key);
    expect(isPeerChatKeyHex(hex)).toBe(true);
    expect(peerChatKeyFromHex(hex)).toEqual(key);
    expect(isPeerChatKeyHex(hex.toUpperCase())).toBe(false);
    expect(isPeerChatKeyHex(hex.slice(2))).toBe(false);
  });
});

describe('메시지', () => {
  it('보낸 틀 — 상대·나·APP에게 p, 보존은 90일, 내용은 암호문', async () => {
    const ev = await send(customerSk, SPONSOR, '안녕하세요');
    expect(ev.tags).toContainEqual(['action', REQUEST_ACTIONS.PEER_MESSAGE]);
    expect(ev.tags.filter(t => t[0] === 'p').map(t => t[1])).toEqual([SPONSOR, CUSTOMER, APP]);
    expect(ev.tags).toContainEqual(['expiration', String(NOW + PEER_CHAT_RETENTION_SEC)]);
    expect(ev.content).not.toContain('안녕하세요');
  });

  it('상대가 자기 키로 연다 · 공개받은 키(운영자)로도 연다', async () => {
    const ev = await send(customerSk, SPONSOR, '계좌 보냈어요');
    const sponsorKey = await derivePeerChatKey(sponsorSk, CUSTOMER, 'ln', 'o1');
    expect(openPeerMessage(ev, { orderId: 'o1', trackTag: TAG, parties, key: sponsorKey })).toEqual({ text: '계좌 보냈어요' });
    const disclosed = peerChatKeyFromHex(peerChatKeyHex(sponsorKey));
    expect(openPeerMessage(ev, { orderId: 'o1', trackTag: TAG, parties, key: disclosed })).toEqual({ text: '계좌 보냈어요' });
  });

  /** 대칭키라 키를 아는 누구든 암호문은 만든다 — 작성자 서명이 당사자여야만 연다(운영자는 끼어들 수 없다) */
  it('당사자가 아닌 사람이 쓴 건 키가 맞아도 안 연다', async () => {
    const key = await derivePeerChatKey(customerSk, SPONSOR, 'ln', 'o1');
    for (const outsider of [app, generateSecretKey()]) {
      const forged = finalizeEvent(peerMessageTemplate({
        appPubkey: APP, trackTag: TAG, orderId: 'o1', myPubkey: getPublicKey(outsider), peerPubkey: SPONSOR, key,
        text: '입금 확인했어요', createdAt: NOW,
      }), outsider);
      expect(openPeerMessage(forged, { orderId: 'o1', trackTag: TAG, parties, key })).toBeNull();
    }
  });

  it('다른 거래의 메시지는 안 연다 — 태그를 바꿔 붙여도 키가 달라 안 풀린다', async () => {
    const other = await send(customerSk, SPONSOR, '다른 거래', 'o2');
    const key = await derivePeerChatKey(sponsorSk, CUSTOMER, 'ln', 'o1');
    expect(openPeerMessage(other, { orderId: 'o1', trackTag: TAG, parties, key })).toBeNull();

    const relabeled = { ...other, tags: other.tags.map(t => (t[0] === 'a' ? [t[0], t[1]!.replace(':o2', ':o1')] : t)) };
    expect(openPeerMessage(relabeled, { orderId: 'o1', trackTag: TAG, parties, key })).toBeNull();
  });

  it('트랙 태그 · action이 다르면 안 연다', async () => {
    const ev = await send(customerSk, SPONSOR, 'x');
    const key = await derivePeerChatKey(sponsorSk, CUSTOMER, 'ln', 'o1');
    expect(openPeerMessage(ev, { orderId: 'o1', trackTag: 'sajwo-tracker-onchain', parties, key })).toBeNull();
    const wrongAction = { ...ev, tags: ev.tags.map(t => (t[0] === 'action' ? ['action', REQUEST_ACTIONS.DISPUTE_MESSAGE] : t)) };
    expect(openPeerMessage(wrongAction, { orderId: 'o1', trackTag: TAG, parties, key })).toBeNull();
  });
});

describe('운영자 부르기 payload', () => {
  const key = 'ab'.repeat(32);
  it('사유가 있어야 하고, 키는 없거나 모양이 맞아야 한다', () => {
    expect(isCallPayload({ type: 'call', reason: '입금이 안 들어와요', peerChatKey: key })).toBe(true);
    expect(isCallPayload({ type: 'call', reason: '상대가 아직 없어요' })).toBe(true);
    expect(isCallPayload({ type: 'call', reason: '  ', peerChatKey: key })).toBe(false);
    expect(isCallPayload({ type: 'call', reason: 'x', peerChatKey: 'zz' })).toBe(false);
    expect(isCallPayload({ type: 'call', reason: 'x'.repeat(2001) })).toBe(false);
    expect(isCallPayload({ type: 'text', content: 'x' })).toBe(false);
  });
});
