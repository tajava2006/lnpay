/**
 * 라이트닝 테스트용 가짜 — **실패하는 노드**와 진짜 서명된 bolt11.
 *
 * 노드는 LND가 실제로 하는 일을 흉내 낸다: 결제 기한이 지난 미결제 인보이스는 취소되고, 잡힌 HTLC는
 * 만기 12블록 전에 스스로 취소된다(`holdexpirydelta`). 호출을 골라 실패시킬 수 있고, "호출은 성공했는데
 * 응답이 유실된" 경우(`throwAfter`)도 만든다 — 크래시 재시작과 같은 모양이다.
 */
import { createHash, randomBytes } from 'node:crypto';
import { encode, sign } from 'bolt11';
import { decode as decodeBolt11 } from 'light-bolt11-decoder';
import type { Event } from 'nostr-tools/core';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { SAJWO_REQUEST_EVENT_KIND, SAJWO_REQUEST_KIND, orderRef } from '@sajwo-tracker/shared/core';
import type { HoldLookup, HoldState, LnNode, PayResult, PayStatus } from '../ln/lnd';
import type { PushConfig } from '../push/send';
import type { OcDeps } from '../onchain';
import type { Daemon } from '../runtime';
import type { LnContext } from '../ln/context';
import { getOrder, type LnOrderRow } from '../ln/store';
import { createHarness, newKey, TEST_TAGS, type Harness, type TestKey } from './fakes';

/** 테스트가 인보이스를 서명할 노드 키 (아무 값이면 된다) */
const PAYEE_KEY = Buffer.from(generateSecretKey()).toString('hex');

/** 진짜로 서명된 bolt11 — 데몬은 실제 디코더로 읽는다 */
export function makeInvoice(opts: { amountSat: number; timestamp: number; expirySec?: number; paymentHash?: string }): {
  bolt11: string; paymentHash: string;
} {
  const paymentHash = opts.paymentHash ?? randomBytes(32).toString('hex');
  const encoded = encode({
    satoshis: opts.amountSat,
    timestamp: opts.timestamp,
    tags: [
      { tagName: 'payment_hash', data: paymentHash },
      { tagName: 'description', data: 'test' },
      { tagName: 'expire_time', data: opts.expirySec ?? 3600 },
    ],
  }, false);
  const signed = sign(encoded, PAYEE_KEY);
  if (!signed.paymentRequest) throw new Error('bolt11 서명 실패');
  return { bolt11: signed.paymentRequest, paymentHash };
}

interface FakeHold {
  amountSat: number;
  bolt11: string;
  expiresAt: number;
  cltvBlocks: number;
  state: HoldState;
  htlcExpiryHeight?: number;
}

type Method = keyof LnNode;

/** LND의 `holdexpirydelta` — 만기 이만큼 전에 홀드를 스스로 취소한다 */
const HOLD_EXPIRY_DELTA = 12;

export class FakeLnNode implements LnNode {
  height = 800_000;
  readonly holds = new Map<string, FakeHold>();
  readonly payments = new Map<string, { bolt11: string; status: PayStatus; attempts: number }>();
  /** 다음 결제의 결과 */
  payResult: () => PayResult = () => ({ status: 'succeeded' });
  probeResult: 'reachable' | 'unreachable' | 'error' = 'reachable';
  /** LND처럼 기한 지난 미결제 인보이스를 스스로 취소한다. 끄면 데몬의 시계만으로 정리해야 한다 */
  autoExpire = true;
  /** 모든 호출이 던진다 */
  down = false;
  /** 호출별로 다음 N번 던진다 (아무 일도 안 일어난다) */
  readonly failNext: Partial<Record<Method, number>> = {};
  /** 호출별로 다음 N번 **일은 하고** 던진다 — 응답이 유실된 경우 */
  readonly throwAfter: Partial<Record<Method, number>> = {};
  readonly calls: Method[] = [];

  constructor(private readonly clock: { now: number }) {}

  private get sec(): number {
    return Math.floor(this.clock.now / 1000);
  }

  private before(method: Method): void {
    this.calls.push(method);
    if (this.down) throw new Error('LND에 닿지 않음');
    const n = this.failNext[method] ?? 0;
    if (n > 0) {
      this.failNext[method] = n - 1;
      throw new Error(`${method} 실패 (가짜)`);
    }
  }

  private after(method: Method): void {
    const n = this.throwAfter[method] ?? 0;
    if (n > 0) {
      this.throwAfter[method] = n - 1;
      throw new Error(`${method} 응답 유실 (가짜)`);
    }
  }

  /** LND가 시간 흐름에 따라 하는 일 */
  private tick(hold: FakeHold): void {
    if (this.autoExpire && hold.state === 'open' && this.sec > hold.expiresAt) hold.state = 'cancelled';
    if (hold.state === 'accepted' && hold.htlcExpiryHeight && this.height >= hold.htlcExpiryHeight - HOLD_EXPIRY_DELTA) {
      hold.state = 'cancelled';
    }
  }

  async blockHeight(): Promise<number> {
    this.before('blockHeight');
    return this.height;
  }

  async addHoldInvoice(p: { paymentHash: string; amountSat: number; expirySec: number; cltvBlocks: number }): Promise<{ bolt11: string }> {
    this.before('addHoldInvoice');
    if (this.holds.has(p.paymentHash)) throw new Error('invoice with payment hash already exists');
    const { bolt11 } = makeInvoice({ amountSat: p.amountSat, timestamp: this.sec, expirySec: p.expirySec, paymentHash: p.paymentHash });
    this.holds.set(p.paymentHash, {
      amountSat: p.amountSat, bolt11, expiresAt: this.sec + p.expirySec, cltvBlocks: p.cltvBlocks, state: 'open',
    });
    this.after('addHoldInvoice');
    return { bolt11 };
  }

  async lookupInvoice(paymentHash: string): Promise<HoldLookup | null> {
    this.before('lookupInvoice');
    const hold = this.holds.get(paymentHash);
    if (!hold) return null;
    this.tick(hold);
    return { state: hold.state, bolt11: hold.bolt11, ...(hold.htlcExpiryHeight ? { htlcExpiryHeight: hold.htlcExpiryHeight } : {}) };
  }

  async settleInvoice(preimageHex: string): Promise<void> {
    this.before('settleInvoice');
    const hash = createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
    const hold = this.holds.get(hash);
    if (!hold) throw new Error('unable to locate invoice');
    this.tick(hold);
    if (hold.state !== 'accepted') throw new Error(`invoice still ${hold.state}`);
    hold.state = 'settled';
    this.after('settleInvoice');
  }

  async cancelInvoice(paymentHash: string): Promise<void> {
    this.before('cancelInvoice');
    const hold = this.holds.get(paymentHash);
    if (!hold) throw new Error('unable to locate invoice');
    if (hold.state === 'settled') throw new Error('invoice already settled');
    hold.state = 'cancelled';
    this.after('cancelInvoice');
  }

  async payInvoice(bolt11: string): Promise<PayResult> {
    this.before('payInvoice');
    const hash = hashOf(bolt11);
    const prev = this.payments.get(hash);
    if (prev?.status === 'succeeded') throw new Error('invoice is already paid');
    const result = this.payResult();
    this.payments.set(hash, { bolt11, status: result.status, attempts: (prev?.attempts ?? 0) + 1 });
    this.after('payInvoice');
    return result;
  }

  async trackPayment(paymentHash: string): Promise<PayStatus | null> {
    this.before('trackPayment');
    return this.payments.get(paymentHash)?.status ?? null;
  }

  async probe(): Promise<'reachable' | 'unreachable' | 'error'> {
    this.before('probe');
    return this.probeResult;
  }

  // ── 바깥 사람이 하는 일 ─────────────────────────────────

  /** 유저가 우리 홀드 인보이스를 결제했다 — HTLC가 잡힌다 */
  pay(bolt11: string): void {
    const hash = hashOf(bolt11);
    const hold = this.holds.get(hash);
    if (!hold) throw new Error('모르는 인보이스');
    this.tick(hold);
    if (hold.state !== 'open') throw new Error(`결제할 수 없는 인보이스: ${hold.state}`);
    hold.state = 'accepted';
    hold.htlcExpiryHeight = this.height + hold.cltvBlocks;
  }

  stateOf(bolt11OrHash: string): HoldState | undefined {
    const hash = /^[0-9a-f]{64}$/.test(bolt11OrHash) ? bolt11OrHash : hashOf(bolt11OrHash);
    const hold = this.holds.get(hash);
    if (hold) this.tick(hold);
    return hold?.state;
  }
}

export function hashOf(bolt11: string): string {
  const section = decodeBolt11(bolt11).sections.find(s => s.name === 'payment_hash');
  if (!section || !('value' in section)) throw new Error('해시 없음');
  return String(section.value);
}

// ── 유저 요청 ───────────────────────────────────────────────

export function lnRequest(
  from: TestKey, appPubkey: string, orderId: string | null, action: string, createdAt: number,
  extra: string[][] = [], content = '',
): Event {
  return finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: createdAt,
    tags: [
      ...(orderId ? [['a', orderRef(appPubkey, orderId)]] : []),
      ['action', action],
      ['t', TEST_TAGS.ln],
      ['p', appPubkey],
      ...extra,
      ['expiration', String(createdAt + 7 * 86400)],
    ],
    content,
  }, from.secretKey);
}

/** 이 오더의 가장 최근 공개 이벤트 */
export function latestOrderEvent(published: Event[], orderId: string): Event | undefined {
  return published
    .filter(e => e.kind === SAJWO_REQUEST_KIND && e.tags.some(t => t[0] === 'd' && t[1] === orderId))
    .sort((a, b) => a.created_at - b.created_at)
    .at(-1);
}

export function tagOf(event: Pick<Event, 'tags'> | undefined, name: string): string | undefined {
  return event?.tags.find(t => t[0] === name)?.[1];
}

// ── 웹 푸시 ─────────────────────────────────────────────────

export interface PushSink {
  config: PushConfig;
  sent: Array<{ url: string }>;
  /** 엔드포인트별 응답 코드 (기본 201) */
  status: Map<string, number>;
}

/** 테스트마다 새 VAPID 키쌍 — 서명이 실제로 돌아야 한다(가짜 fetch는 검증하지 않는다) */
export async function pushSink(): Promise<PushSink> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const sink: PushSink = {
    sent: [],
    status: new Map(),
    config: {
      privateD: jwk.d!,
      publicKey: Buffer.from(raw).toString('base64url'),
      subject: 'https://example.test',
      fetch: async url => {
        sink.sent.push({ url });
        return { status: sink.status.get(url) ?? 201 };
      },
    },
  };
  return sink;
}

// ── 라이트닝 하네스 ─────────────────────────────────────────

export interface LnHarness extends Harness {
  node: FakeLnNode;
  /** BTC/KRW — null이면 시세 없음 */
  price: { value: number | null };
  push: PushSink;
  customer: TestKey;
  sponsor: TestKey;
  daemon: Daemon;
  ln: LnContext;
  /** n바퀴 (각각 묵힘 시간을 넘긴다) — 효과가 다음 효과를 쌓으므로 여러 번 돈다 */
  run(n?: number): Promise<void>;
  /** 유저 요청을 넣고 몇 바퀴 */
  send(event: Event, n?: number): Promise<void>;
  order(orderId: string): LnOrderRow | undefined;
  /** 시계를 앞으로 (초) */
  advance(sec: number): void;
}

/** 1 BTC = 1.5억 원 — 10만 원이면 66,667 sats */
export const BTC_KRW = 150_000_000;

export async function createLnHarness(
  opts: { operators?: number; onchain?: (clock: { now: number }) => OcDeps } = {},
): Promise<LnHarness> {
  const push = await pushSink();
  const price = { value: BTC_KRW as number | null };
  let node!: FakeLnNode;
  const h = createHarness({
    ...opts,
    ln: clock => {
      node = new FakeLnNode(clock);
      return { node, price: () => price.value, push: push.config };
    },
  });
  const daemon = h.start();
  const lh: LnHarness = {
    ...h,
    node, price, push, daemon,
    ln: daemon.ln!.ctx,
    customer: newKey(),
    sponsor: newKey(),
    async run(n = 4) {
      for (let i = 0; i < n; i++) await h.settle(daemon);
    },
    async send(event, n = 4) {
      h.relay.inject(event);
      await lh.run(n);
    },
    order: orderId => getOrder(daemon.ln!.ctx, orderId),
    advance(sec) {
      h.clock.now += sec * 1000;
    },
  };
  return lh;
}
