/**
 * 키만으로 되살리기 — 내가 보낸 요청에서 로컬 기록을 다시 채운다
 *
 * 암호는 진짜 NIP-44다. 이 기능은 "보낸 사람도 자기 키로 푼다"(대화 키가 양쪽 공통)는 전제 위에 서 있다 —
 * 그 전제를 흉내가 아니라 실제 암호로 확인한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';
import type { Event } from 'nostr-tools/core';
import {
  APP_PUBKEY, CLIENT_TAG, CLIENT_TAG_ONCHAIN, REQUEST_ACTIONS, MESSAGE_KIND, ORDER_KIND,
  nip44Encrypt,
} from '@sajwo-tracker/shared';

const SK = generateSecretKey();
const ME = getPublicKey(SK);
const SPONSOR = getPublicKey(generateSecretKey());
const ACCOUNT = { bankName: '국민', accountNumber: '123-45', holderName: '갑' };
const NOW = 1_800_000_000;

function request(action: string, orderId: string, extra: string[][] = [], content = '', at = NOW, sk = SK, t = CLIENT_TAG): Event {
  return finalizeEvent({
    kind: MESSAGE_KIND,
    created_at: at,
    tags: [['a', `${ORDER_KIND}:${APP_PUBKEY}:${orderId}`], ['action', action], ['t', t], ['p', APP_PUBKEY], ...extra],
    content,
  }, sk);
}

const orderRequest = (orderId: string, at = NOW) =>
  request(REQUEST_ACTIONS.ORDER_REQUEST, orderId, [['price', '32900', 'KRW'], ['deadline', String(NOW + 86_400)]], '', at);

const accountInfo = (orderId: string, account = ACCOUNT) =>
  request(REQUEST_ACTIONS.ACCOUNT_INFO, orderId, [['p', SPONSOR], ['commitment', 'c'.repeat(64)]],
    nip44Encrypt(JSON.stringify({ accountInfo: account, salt: 's' }), SK, SPONSOR));

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const ln = async () => ({
  own: await import('../nostr/own-requests'),
  local: await import('../buyer/order-store'),
  book: await import('../sponsor/order-store'),
});

describe('라이트닝', () => {
  it('내 의뢰 요청으로 고객 기록을 되살린다 — 계좌 전달 버튼의 전제', async () => {
    const { own, local } = await ln();
    own.handleOwnLnRequest(orderRequest('o1'), SK, ME);
    expect(local.getSnapshot().o1).toMatchObject({ orderId: 'o1', price: 32900, expiration: NOW + 86_400 });
    expect(local.getSnapshot().o1?.raw).toBeDefined();
  });

  it('남이 쓴 요청 · 이미 있는 기록은 건드리지 않는다', async () => {
    const { own, local } = await ln();
    own.handleOwnLnRequest(request(REQUEST_ACTIONS.ORDER_REQUEST, 'x', [['price', '1'], ['deadline', '1']], '', NOW, generateSecretKey()), SK, ME);
    expect(local.getSnapshot().x).toBeUndefined();

    local.addOrder({ orderId: 'o1', price: 1, memo: '내 메모', createdAt: 1, expiration: 2 });
    own.handleOwnLnRequest(orderRequest('o1'), SK, ME);
    expect(local.getSnapshot().o1?.memo).toBe('내 메모');
  });

  it('후원자에게 보낸 계좌를 내 키로 풀어 되살린다 — 두 번 보내지 않게', async () => {
    const { own, local } = await ln();
    own.handleOwnLnRequest(orderRequest('o1'), SK, ME);
    own.handleOwnLnRequest(accountInfo('o1'), SK, ME);
    expect(local.getSnapshot().o1?.accountInfo).toEqual(ACCOUNT);
  });

  it('계좌가 의뢰보다 먼저 와도 잃지 않는다', async () => {
    const { own, local } = await ln();
    own.handleOwnLnRequest(accountInfo('o1'), SK, ME);
    own.handleOwnLnRequest(orderRequest('o1'), SK, ME);
    expect(local.getSnapshot().o1?.accountInfo).toEqual(ACCOUNT);
  });

  it('이미 기록된 계좌는 덮지 않는다', async () => {
    const { own, local } = await ln();
    own.handleOwnLnRequest(orderRequest('o1'), SK, ME);
    local.setAccountInfo('o1', ACCOUNT);
    own.handleOwnLnRequest(accountInfo('o1', { ...ACCOUNT, accountNumber: '999' }), SK, ME);
    expect(local.getSnapshot().o1?.accountInfo).toEqual(ACCOUNT);
  });

  it('공개 오더가 먼저 와 있었으면 그 상태를 바로 입힌다', async () => {
    const { own, local, book } = await ln();
    const published = finalizeEvent({
      kind: ORDER_KIND, created_at: NOW,
      tags: [['d', 'o1'], ['t', CLIENT_TAG], ['status', 'active'], ['state', 'invoiced'], ['price', '32900', 'KRW'],
        ['customer', ME], ['sponsor', SPONSOR], ['deadline', String(NOW + 86_400)], ['expiration', String(NOW + 90 * 86_400)]],
      content: '',
    }, generateSecretKey());
    // 오더북 스토어는 APP 서명만 받는 파서를 거치지 않고 넣는다 — 여기서 보는 건 되살린 뒤의 상태 반영이다
    book.upsertOrder({
      orderId: 'o1', state: 'invoiced', customerPubkey: ME, sponsorPubkey: SPONSOR, price: 32900,
      createdAt: NOW, updatedAt: NOW, expiration: NOW + 86_400, raw: { ...published, pubkey: APP_PUBKEY },
    });
    own.handleOwnLnRequest(orderRequest('o1'), SK, ME);
    expect(local.getSnapshot().o1?.sponsorPubkey).toBe(SPONSOR);
  });
});

describe('온체인', () => {
  const oc = async () => ({
    own: await import('../onchain/nostr/own-requests'),
    refund: await import('../onchain/refund-address-store'),
    claims: await import('../onchain/claim-store'),
  });
  const toApp = (payload: object) => nip44Encrypt(JSON.stringify(payload), SK, APP_PUBKEY);

  it('의뢰 요청에서 환불 주소를 되살린다 (O-021 대조의 재료)', async () => {
    const { own, refund } = await oc();
    own.handleOwnOnchainRequest(
      request(REQUEST_ACTIONS.ONCHAIN_ORDER_REQUEST, 'c1', [], toApp({ refundAddress: 'tb1qrefund' }), NOW, SK, CLIENT_TAG_ONCHAIN),
      SK, ME,
    );
    expect(refund.getRefundAddress('c1')).toBe('tb1qrefund');
  });

  it('클레임 값을 되살린다 — 다시 클레임했으면 나중 것', async () => {
    const { own, claims } = await oc();
    const claim = (addr: string, at: number) =>
      request(REQUEST_ACTIONS.ONCHAIN_CLAIM, 'c1', [], toApp({ payoutAddress: addr, feerateSatPerVb: 5 }), at, SK, CLIENT_TAG_ONCHAIN);
    own.handleOwnOnchainRequest(claim('tb1qnew', NOW + 60), SK, ME);
    own.handleOwnOnchainRequest(claim('tb1qold', NOW), SK, ME); // 늦게 도착한 옛 클레임
    expect(claims.getMyClaim('c1')).toMatchObject({ payoutAddress: 'tb1qnew', feerateSatPerVb: 5, requestedAt: (NOW + 60) * 1000 });
  });

  it('남이 쓴 요청은 무시한다', async () => {
    const { own, refund } = await oc();
    const other = generateSecretKey();
    own.handleOwnOnchainRequest(
      request(REQUEST_ACTIONS.ONCHAIN_ORDER_REQUEST, 'c1', [], nip44Encrypt('{"refundAddress":"evil"}', other, APP_PUBKEY), NOW, other, CLIENT_TAG_ONCHAIN),
      SK, ME,
    );
    expect(refund.getRefundAddress('c1')).toBeUndefined();
  });
});

describe('키 읽기', () => {
  it('nsec과 hex를 받고 그 밖은 거절한다', async () => {
    const { parseSecretKey } = await import('../key-backup');
    expect(parseSecretKey(`  ${nsecEncode(SK)}\n`)).toEqual(SK);
    expect(parseSecretKey(Array.from(SK, b => b.toString(16).padStart(2, '0')).join(''))).toEqual(SK);
    expect(parseSecretKey('nsec1잘못')).toBeNull();
    expect(parseSecretKey('npub1abc')).toBeNull();
    expect(parseSecretKey('12ab')).toBeNull();
  });
});
