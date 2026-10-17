/**
 * 지정 거래 규약 — 스냅샷 봉하기·열기, 지정 태그, 확인 코드, 주소 읽기 (docs/PROTOCOL.md §2)
 *
 * 스냅샷을 열면 **공개 오더와 똑같은 가짜 이벤트**가 나와야 한다 — 그래야 기존 파서·저장소가 손대지 않고 돈다.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { ORDER_KIND } from '../constants';
import {
  DESIGNATED_ORDER_KIND, checkCode, designatedOrderTemplate, isLnDesignatedOrderPayload,
  isOnchainDesignatedOrderPayload, openDesignatedOrder, parsePubkeyInput,
} from '../designated';
import { isStoredLnOrder, lnOrderTags, parseLnOrderEvent } from '../ln/order';
import { isStoredOnchainOrder, onchainOrderTags, parseOnchainOrder, type OnchainOrder } from '../onchain/order';

const app = generateSecretKey();
const APP = getPublicKey(app);
const customer = generateSecretKey();
const sponsor = generateSecretKey();
const SPONSOR = getPublicKey(sponsor);
const NOW = 1_800_000_000;

function snapshotFor(recipientSk: Uint8Array, tags: string[][], appSk = app) {
  return finalizeEvent(designatedOrderTemplate({
    orderId: 'o1', recipient: getPublicKey(recipientSk), trackTag: 'sajwo-tracker', tags,
    retainUntil: NOW + 86_400, createdAt: NOW, appSecretKey: appSk,
  }), appSk);
}

const lnTags = () => lnOrderTags({
  orderId: 'o1', state: 'requested', customerPubkey: getPublicKey(customer), price: 32_900, deadline: NOW + 86_400,
  designatedSponsor: SPONSOR,
}, 'sajwo-tracker', NOW + 86_400);

describe('스냅샷 — 봉하고 열면 공개 오더와 같은 이벤트', () => {
  it('수신자가 열면 가짜 오더 이벤트가 나오고, 기존 파서가 그대로 읽는다', () => {
    const event = snapshotFor(sponsor, lnTags());
    expect(event.kind).toBe(DESIGNATED_ORDER_KIND);
    expect(event.tags).toContainEqual(['p', SPONSOR]);
    expect(event.tags).toContainEqual(['t', 'sajwo-tracker']);
    expect(event.content).not.toContain('32900'); // 금액은 암호문 안에

    const opened = openDesignatedOrder(event, sponsor, APP)!;
    expect(opened.kind).toBe(ORDER_KIND);
    expect(opened.pubkey).toBe(APP);
    const order = parseLnOrderEvent(opened, APP)!;
    expect(order).toMatchObject({ orderId: 'o1', price: 32_900, designatedSponsor: SPONSOR, state: 'requested' });
    expect(isStoredLnOrder(JSON.parse(JSON.stringify(order)))).toBe(true);
  });

  it('남의 스냅샷은 못 연다 · APP이 아닌 발행자는 버린다 · 망가진 내용은 버린다', () => {
    const event = snapshotFor(sponsor, lnTags());
    expect(openDesignatedOrder(event, customer, APP)).toBeNull(); // 다른 사람의 키
    const forged = snapshotFor(sponsor, lnTags(), generateSecretKey());
    expect(openDesignatedOrder(forged, sponsor, APP)).toBeNull(); // 가짜 발행자
    const broken = finalizeEvent({ ...designatedOrderTemplate({
      orderId: 'o1', recipient: SPONSOR, trackTag: 't', tags: [], retainUntil: NOW, createdAt: NOW, appSecretKey: app,
    }), content: 'x' }, app);
    expect(openDesignatedOrder(broken, sponsor, APP)).toBeNull();
  });
});

describe('지정 태그', () => {
  const nip = (tags: string[][], name: string) => tags.filter(t => t[0] === name);

  it('라이트닝 — 지정이면 NIP-69 태그·source가 없다(공개되지 않는다)', () => {
    const tags = lnOrderTags({
      orderId: 'o1', state: 'requested', customerPubkey: 'c', price: 1, deadline: NOW, designatedSponsor: SPONSOR,
    }, 't', NOW, 'https://app.test');
    expect(nip(tags, 'designated-sponsor')).toEqual([['designated-sponsor', SPONSOR]]);
    for (const n of ['k', 's', 'amt', 'fa', 'y', 'z', 'source']) expect(nip(tags, n), n).toEqual([]);
  });

  it('온체인 — 지정이면 NIP-69 대신 우리 network만, 파서·저장소 확인을 통과한다', () => {
    const order: OnchainOrder = {
      orderId: 'o1', state: 'listed', customerPubkey: 'c', amountSat: 100_000, createdAt: NOW, updatedAt: NOW,
      expiration: NOW + 86_400, network: 'signet', designatedSponsor: SPONSOR, raw: {},
    };
    const tags = onchainOrderTags(order, 'T', 'https://app.test');
    expect(nip(tags, 'designated-sponsor')).toEqual([['designated-sponsor', SPONSOR]]);
    expect(nip(tags, 'network')).toEqual([['network', 'signet']]);
    for (const n of ['k', 's', 'amt', 'layer', 'source']) expect(nip(tags, n), n).toEqual([]);
    const parsed = parseOnchainOrder({ kind: ORDER_KIND, pubkey: 'p', created_at: NOW, tags }, 'T')!;
    expect(parsed.designatedSponsor).toBe(SPONSOR);
    expect(isStoredOnchainOrder(JSON.parse(JSON.stringify(parsed)))).toBe(true);
  });
});

describe('요청 내용', () => {
  it('지정 후원자는 hex 64자여야 한다', () => {
    expect(isLnDesignatedOrderPayload({ price: 1, deadline: NOW, designatedSponsor: SPONSOR })).toBe(true);
    expect(isLnDesignatedOrderPayload({ price: 1, deadline: NOW, designatedSponsor: nip19.npubEncode(SPONSOR) })).toBe(false);
    expect(isOnchainDesignatedOrderPayload({
      amountSat: 1, customerXonly: 'x', refundAddress: 'a', designatedSponsor: SPONSOR,
    })).toBe(true);
    expect(isOnchainDesignatedOrderPayload({ amountSat: 1, customerXonly: 'x', designatedSponsor: SPONSOR })).toBe(false);
  });
});

describe('주소 · 확인 코드', () => {
  it('npub · nprofile · hex · nostr: 접두사를 읽는다', () => {
    const npub = nip19.npubEncode(SPONSOR);
    expect(parsePubkeyInput(npub)).toBe(SPONSOR);
    expect(parsePubkeyInput(` nostr:${npub} `)).toBe(SPONSOR);
    expect(parsePubkeyInput(nip19.nprofileEncode({ pubkey: SPONSOR, relays: [] }))).toBe(SPONSOR);
    expect(parsePubkeyInput(SPONSOR.toUpperCase())).toBe(SPONSOR);
  });

  it('nsec·쓰레기는 받지 않는다 — 비밀키를 주소 칸에 붙여넣는 실수를 끊는다', () => {
    expect(parsePubkeyInput(nip19.nsecEncode(sponsor))).toBeNull();
    expect(parsePubkeyInput('npub1garbage')).toBeNull();
    expect(parsePubkeyInput('')).toBeNull();
  });

  it('확인 코드는 npub 앞 6 · 뒤 6이고, 다른 키는 다른 코드다', () => {
    const body = nip19.npubEncode(SPONSOR).slice(5);
    expect(checkCode(SPONSOR)).toBe(`${body.slice(0, 6)}…${body.slice(-6)}`);
    expect(checkCode(getPublicKey(customer))).not.toBe(checkCode(SPONSOR));
  });
});
