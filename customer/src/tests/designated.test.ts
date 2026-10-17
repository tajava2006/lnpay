/**
 * 지정 거래 — 유저 앱 (docs/PLAN-DESIGNATED-TRADE.md §8)
 *
 * 암호는 진짜 NIP-44다. 데몬이 APP 키로 봉한 스냅샷은 NIP-44 대화 키가 양쪽 공통이라 **수신자 키로도 같은 것을 만들
 * 수 있다** — 그래서 APP 비밀키 없이도 "APP이 나에게 보낸 스냅샷"을 진짜 암호문으로 만든다.
 *
 * 지켜야 할 것: 스냅샷을 열면 공개 오더와 같은 길로 저장소에 들어가고, **오더북에는 안 뜨고** 지정된 사람의
 * "나를 지정한 거래"에만 뜬다. 키만 있으면 다른 기기에서 내 지정 의뢰가 되살아난다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import type { Event } from 'nostr-tools/core';
import {
  APP_PUBKEY, CLIENT_TAG, CLIENT_TAG_ONCHAIN, DESIGNATED_ORDER_KIND, MESSAGE_KIND, ORDER_KIND, REQUEST_ACTIONS,
  checkCode, designatedOrderD, nip44Encrypt, openDesignatedOrder,
} from '@sajwo-tracker/shared';
import { lnOrderTags } from '@sajwo-tracker/shared/ln';
import { onchainOrderTags, type OnchainOrder } from '@sajwo-tracker/shared/onchain';
import { designatedLnOffers, isOnLnBook, readCounterparty } from '../designated/view';
import { lnCardView } from '../ln/card-view';
import { onchainCardView } from '../onchain/card-view';

const CUSTOMER_SK = generateSecretKey();
const CUSTOMER = getPublicKey(CUSTOMER_SK);
const SPONSOR_SK = generateSecretKey();
const SPONSOR = getPublicKey(SPONSOR_SK);
const NOW = Math.floor(Date.now() / 1000);

/** APP이 `recipient`에게 보낸 스냅샷 — 수신자 키로 봉한다(대화 키가 같다) */
function snapshot(tags: string[][], orderId: string, recipientSk: Uint8Array, trackTag: string, at = NOW): Event {
  const recipient = getPublicKey(recipientSk);
  return {
    kind: DESIGNATED_ORDER_KIND, pubkey: APP_PUBKEY, created_at: at, id: `${orderId}-${recipient.slice(0, 6)}-${at}`, sig: '',
    tags: [['d', designatedOrderD(orderId, recipient)], ['p', recipient], ['t', trackTag], ['expiration', String(at + 86_400)]],
    content: nip44Encrypt(JSON.stringify(tags), recipientSk, APP_PUBKEY),
  };
}

const lnTags = (orderId: string, over: { state?: 'requested' | 'claimed'; sponsor?: string } = {}) => lnOrderTags({
  orderId, state: over.state ?? 'requested', customerPubkey: CUSTOMER, price: 32_900, deadline: NOW + 86_400,
  designatedSponsor: SPONSOR, ...(over.sponsor ? { sponsorPubkey: over.sponsor } : {}),
}, CLIENT_TAG, NOW + 86_400);

function ocOrder(over: Partial<OnchainOrder> = {}): OnchainOrder {
  return {
    orderId: 'c1', state: 'listed', customerPubkey: CUSTOMER, amountSat: 100_000, createdAt: NOW, updatedAt: NOW,
    expiration: NOW + 86_400, network: 'signet', designatedSponsor: SPONSOR, raw: {}, ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('상대 주소 읽기', () => {
  it('npub · nostr: 접두사를 읽고 확인 코드를 낸다', () => {
    const npub = nip19.npubEncode(SPONSOR);
    expect(readCounterparty(` nostr:${npub} `, CUSTOMER)).toEqual({ kind: 'ok', pubkey: SPONSOR, code: checkCode(SPONSOR) });
  });

  it('비어 있음 · 비밀키 · 쓰레기 · 내 주소를 가른다', () => {
    expect(readCounterparty('  ', CUSTOMER).kind).toBe('empty');
    const nsec = readCounterparty(nip19.nsecEncode(SPONSOR_SK), CUSTOMER);
    expect(nsec.kind === 'invalid' && /비밀키/.test(nsec.message)).toBe(true);
    expect(readCounterparty('npub1garbage', CUSTOMER).kind).toBe('invalid');
    expect(readCounterparty(nip19.npubEncode(CUSTOMER), CUSTOMER).kind).toBe('self');
  });
});

describe('라이트닝 — 스냅샷이 저장소로', () => {
  it('지정 후원자: 열면 오더북 저장소에 들어가지만 오더북엔 안 뜨고 "나를 지정한 거래"에 뜬다', async () => {
    const sponsor = await import('../sponsor/nostr/service');
    const book = await import('../sponsor/order-store');
    const opened = openDesignatedOrder(snapshot(lnTags('d1'), 'd1', SPONSOR_SK, CLIENT_TAG), SPONSOR_SK)!;
    expect(opened.kind).toBe(ORDER_KIND);
    sponsor.handleAdminOrder(opened, SPONSOR);

    const order = book.getSnapshot().d1!;
    expect(order).toMatchObject({ orderId: 'd1', price: 32_900, designatedSponsor: SPONSOR, state: 'requested' });
    expect(isOnLnBook(order)).toBe(false);
    expect(designatedLnOffers(Object.values(book.getSnapshot()), SPONSOR, NOW).map(o => o.orderId)).toEqual(['d1']);
    // 지정된 사람이 아니면(고객 본인 포함) "나를 지정한 거래"에 없다
    expect(designatedLnOffers([order], CUSTOMER, NOW)).toEqual([]);
    expect(designatedLnOffers([order], getPublicKey(generateSecretKey()), NOW)).toEqual([]);
  });

  it('맡은 뒤에는 "나를 지정한 거래"에서 빠진다', async () => {
    const sponsor = await import('../sponsor/nostr/service');
    const book = await import('../sponsor/order-store');
    sponsor.handleAdminOrder(openDesignatedOrder(snapshot(lnTags('d1', { state: 'claimed', sponsor: SPONSOR }), 'd1', SPONSOR_SK, CLIENT_TAG), SPONSOR_SK)!, SPONSOR);
    expect(designatedLnOffers(Object.values(book.getSnapshot()), SPONSOR, NOW)).toEqual([]);
  });

  it('고객: 내 로컬 의뢰에 상태가 입혀진다', async () => {
    const buyer = await import('../buyer/nostr/service');
    const local = await import('../buyer/order-store');
    local.addOrder({ orderId: 'd1', price: 32_900, memo: '', createdAt: NOW, expiration: NOW + 86_400, designatedSponsor: SPONSOR });
    buyer.handleAdminOrder(openDesignatedOrder(snapshot(lnTags('d1'), 'd1', CUSTOMER_SK, CLIENT_TAG), CUSTOMER_SK)!, CUSTOMER);
    expect(local.getSnapshot().d1?.adminState).toBe('requested');
  });

  it('남의 스냅샷 · APP이 아닌 발행자는 열리지 않는다', () => {
    const event = snapshot(lnTags('d1'), 'd1', SPONSOR_SK, CLIENT_TAG);
    expect(openDesignatedOrder(event, generateSecretKey())).toBeNull();
    expect(openDesignatedOrder({ ...event, pubkey: getPublicKey(generateSecretKey()) }, SPONSOR_SK)).toBeNull();
  });
});

describe('온체인 — 스냅샷이 저장소로', () => {
  it('오더북(listedOrders)에서 빠지고 지정된 사람의 designatedToMe에만', async () => {
    const service = await import('../onchain/nostr/service');
    const store = await import('../onchain/store');
    const tags = onchainOrderTags(ocOrder(), CLIENT_TAG_ONCHAIN);
    await service.handleOrderEvent(openDesignatedOrder(snapshot(tags, 'c1', SPONSOR_SK, CLIENT_TAG_ONCHAIN), SPONSOR_SK)!, SPONSOR);
    expect(store.getOnchainOrder('c1')?.designatedSponsor).toBe(SPONSOR);
    expect(store.listedOrders(SPONSOR)).toEqual([]);
    expect(store.designatedToMe(SPONSOR).map(o => o.orderId)).toEqual(['c1']);
    expect(store.designatedToMe(getPublicKey(generateSecretKey()))).toEqual([]);
    // 공개 의뢰는 그대로 오더북에
    await service.handleOrderEvent({
      kind: ORDER_KIND, pubkey: APP_PUBKEY, created_at: NOW, id: 'pub', sig: '', content: '',
      tags: onchainOrderTags(ocOrder({ orderId: 'p1', designatedSponsor: undefined }), CLIENT_TAG_ONCHAIN),
    }, SPONSOR);
    expect(store.listedOrders(SPONSOR).map(o => o.orderId)).toEqual(['p1']);
  });
});

describe('키만으로 되살리기', () => {
  const request = (action: string, orderId: string, content: string, t: string): Event => finalizeEvent({
    kind: MESSAGE_KIND, created_at: NOW,
    tags: [['a', `${ORDER_KIND}:${APP_PUBKEY}:${orderId}`], ['action', action], ['t', t], ['p', APP_PUBKEY]],
    content,
  }, CUSTOMER_SK);
  const toApp = (payload: object) => nip44Encrypt(JSON.stringify(payload), CUSTOMER_SK, APP_PUBKEY);

  it('라이트닝 지정 의뢰 — 금액·기한·상대를 암호문에서 되살린다', async () => {
    const own = await import('../nostr/own-requests');
    const local = await import('../buyer/order-store');
    own.handleOwnLnRequest(request(REQUEST_ACTIONS.DESIGNATED_ORDER_REQUEST, 'd1',
      toApp({ price: 32_900, deadline: NOW + 86_400, designatedSponsor: SPONSOR }), CLIENT_TAG), CUSTOMER_SK, CUSTOMER);
    expect(local.getSnapshot().d1).toMatchObject({
      orderId: 'd1', price: 32_900, expiration: NOW + 86_400, designatedSponsor: SPONSOR,
    });
    expect(local.getSnapshot().d1?.raw).toBeDefined();
  });

  it('온체인 지정 의뢰 — 환불 주소를 되살린다', async () => {
    const own = await import('../onchain/nostr/own-requests');
    const refund = await import('../onchain/refund-address-store');
    own.handleOwnOnchainRequest(request(REQUEST_ACTIONS.ONCHAIN_DESIGNATED_ORDER_REQUEST, 'c1', toApp({
      amountSat: 100_000, customerXonly: 'aa'.repeat(32), refundAddress: ' tb1qrefund ', designatedSponsor: SPONSOR,
    }), CLIENT_TAG_ONCHAIN), CUSTOMER_SK, CUSTOMER);
    expect(refund.getRefundAddress('c1')).toBe('tb1qrefund');
  });
});

describe('카드', () => {
  it('라이트닝 — 지정 초안은 "지정한 상대에게 보내기", 양쪽에 상대 확인 코드', () => {
    const local = { orderId: 'd1', price: 1000, memo: '', createdAt: NOW, expiration: NOW + 86_400, designatedSponsor: SPONSOR };
    const draft = lnCardView({ orderId: 'd1', order: null, local, myPubkey: CUSTOMER, now: NOW });
    expect(draft.actions).toEqual([{ kind: 'publish', designated: true }]);
    expect(draft.designated).toEqual({ counterpartyCode: checkCode(SPONSOR) });

    const order = {
      orderId: 'd1', state: 'verified' as const, customerPubkey: CUSTOMER, sponsorPubkey: SPONSOR, price: 1000,
      createdAt: NOW, updatedAt: NOW, expiration: NOW + 86_400, designatedSponsor: SPONSOR, raw: {},
    };
    expect(lnCardView({ orderId: 'd1', order, local: null, myPubkey: SPONSOR, now: NOW }).designated)
      .toEqual({ counterpartyCode: checkCode(CUSTOMER) });
    // 공개 의뢰는 지정 표시가 없다
    const pub = lnCardView({ orderId: 'p1', order: null, local: { ...local, designatedSponsor: undefined }, myPubkey: CUSTOMER, now: NOW });
    expect(pub.designated).toBeNull();
    expect(pub.actions).toEqual([{ kind: 'publish', designated: false }]);
  });

  it('온체인 — 고객에겐 지정 후원자의, 후원자에겐 고객의 확인 코드', () => {
    expect(onchainCardView(ocOrder(), 'customer', NOW, []).designated).toEqual({ counterpartyCode: checkCode(SPONSOR) });
    expect(onchainCardView(ocOrder({ state: 'bonded', sponsorPubkey: SPONSOR }), 'sponsor', NOW, []).designated)
      .toEqual({ counterpartyCode: checkCode(CUSTOMER) });
    expect(onchainCardView(ocOrder({ designatedSponsor: undefined }), 'customer', NOW, []).designated).toBeNull();
  });
});
