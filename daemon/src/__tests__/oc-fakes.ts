/**
 * 온체인 테스트용 가짜 체인 + 하네스 + 유저가 하는 일
 *
 * 체인은 esplora처럼 군다: **소모된 UTXO는 목록에서 빠지고**(멤풀 소모 포함), 소모 증인을 돌려주고, 멤풀에서
 * 쫓겨난 tx는 모른다고 한다. 서명은 진짜다 — 고객·후원자 키로 PSBT에 서명하고 데몬이 검증·완성한다.
 */
import type { Event } from 'nostr-tools/core';
import { finalizeEvent } from 'nostr-tools/pure';
import { REQUEST_ACTIONS, MESSAGE_KIND, nip44Decrypt, nip44Encrypt, orderRef } from '@sajwo-tracker/shared/core';
import {
  buildSettlementTx, bytesToHex, deriveEscrowAddress, deriveSingleKeyAddress, fromPsbtBase64, fromRawHex,
  onchainMessageExpiration, signSettlement, toPsbtBase64, xonlyFromPrivkey,
  type AddressFunds, type ChainAdapter, type ChainOutpoint, type ChainQuery, type ChainUtxo, type EscrowDescriptor,
  type FeeEstimates, type SpendInfo, type TxStatus,
} from '@sajwo-tracker/shared/onchain';
import { loadSettings, saveSettings } from '../admin/settings';
import type { OcContext } from '../onchain/context';
import { getOc, type OcRow } from '../onchain/store';
import { TEST_TAGS, type TestKey } from './fakes';
import { createLnHarness, tagOf, type LnHarness } from './ln-fakes';

type Tx = ReturnType<typeof fromRawHex>;

const key = (o: ChainOutpoint) => `${o.txid}:${o.vout}`;

export class FakeChain implements ChainAdapter {
  private readonly utxos = new Map<string, ChainUtxo[]>();
  private readonly txs = new Map<string, { seen: boolean; confirmations: number }>();
  /** outpoint → 그걸 쓴 tx */
  private readonly spends = new Map<string, Tx>();
  readonly broadcasted: string[] = [];
  fees: FeeEstimates = { fastest: 4, halfHour: 2, hour: 1, economy: 1, minimum: 1 };
  feesKnown = true;
  /** 다음 N번 브로드캐스트를 실패시킨다 */
  failBroadcast = 0;
  tip = 100;

  /** 이 주소로 자금이 들어왔다 */
  fund(address: string, utxo: { txid: string; vout: number; valueSat: number; confirmations: number }): void {
    this.utxos.set(address, [...(this.utxos.get(address) ?? []), { ...utxo }]);
    this.txs.set(utxo.txid, { seen: true, confirmations: utxo.confirmations });
  }

  /** 컨펌 수를 바꾼다 (리오그면 줄인다) */
  confirm(txid: string, confirmations: number): void {
    const t = this.txs.get(txid);
    if (t) t.confirmations = confirmations;
    for (const list of this.utxos.values()) for (const u of list) if (u.txid === txid) u.confirmations = confirmations;
  }

  /** 멤풀에서 쫓겨났다 — 노드가 모르게 되고, 쓴 입력이 되살아난다 */
  evict(txid: string): void {
    const t = this.txs.get(txid);
    if (t) t.seen = false;
    for (const [k, tx] of this.spends) if (tx.id === txid) this.spends.delete(k);
  }

  /** 누가 이 tx를 체인에 올렸다 (우리 말고 — 타임락 회수 등) */
  inject(tx: Tx, confirmations: number): void {
    this.record(tx);
    this.confirm(tx.id, confirmations);
  }

  spenderOf(o: ChainOutpoint): Tx | undefined {
    return this.spends.get(key(o));
  }

  async getAddressFunds(address: string): Promise<ChainQuery<AddressFunds>> {
    const list = (this.utxos.get(address) ?? [])
      .filter(u => !this.spends.has(key(u)) && this.txs.get(u.txid)?.seen !== false);
    return {
      known: true,
      value: { confirmed: list.filter(u => u.confirmations > 0), mempool: list.filter(u => u.confirmations === 0) },
    };
  }

  async getTxStatus(txid: string): Promise<ChainQuery<TxStatus>> {
    const t = this.txs.get(txid);
    if (!t || !t.seen) return { known: true, value: { seen: false, confirmed: false, confirmations: 0 } };
    return { known: true, value: { seen: true, confirmed: t.confirmations > 0, confirmations: t.confirmations } };
  }

  async getSpend(outpoint: ChainOutpoint): Promise<ChainQuery<SpendInfo>> {
    const tx = this.spends.get(key(outpoint));
    if (!tx) return { known: true, value: { spent: false } };
    const witness = tx.getInput(0).finalScriptWitness?.map(w => bytesToHex(w)) ?? null;
    return { known: true, value: { spent: true, txid: tx.id, confirmed: (this.txs.get(tx.id)?.confirmations ?? 0) > 0, witness } };
  }

  async getFeeEstimates(): Promise<ChainQuery<FeeEstimates>> {
    return this.feesKnown ? { known: true, value: this.fees } : { known: false, reason: 'fees down' };
  }

  async getTipHeight(): Promise<ChainQuery<number>> {
    return { known: true, value: this.tip };
  }

  async broadcastTx(rawHex: string): Promise<ChainQuery<string>> {
    if (this.failBroadcast > 0) {
      this.failBroadcast -= 1;
      return { known: false, reason: '/tx → 503 upstream down' };
    }
    this.broadcasted.push(rawHex);
    const tx = fromRawHex(rawHex);
    this.record(tx);
    return { known: true, value: tx.id };
  }

  private record(tx: Tx): void {
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      if (input.txid && input.index !== undefined) this.spends.set(`${bytesToHex(input.txid)}:${input.index}`, tx);
    }
    const prev = this.txs.get(tx.id);
    this.txs.set(tx.id, { seen: true, confirmations: prev?.confirmations ?? 0 });
  }
}

// ── 키와 주소 (signet) ──────────────────────────────────────

const sk = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i + n);
/** 고객·후원자의 **주문별** 키 (앱은 nostr 키에서 파생한다 — 여기선 고정값) */
export const SK_C = sk(1);
export const SK_S = sk(40);
export const XC = xonlyFromPrivkey(SK_C);
export const XS = xonlyFromPrivkey(SK_S);
/** 후원자가 받을 주소, 고객이 환불 받을 주소 */
export const PAYOUT = deriveSingleKeyAddress(xonlyFromPrivkey(sk(120)), 'signet');
export const REFUND = deriveSingleKeyAddress(xonlyFromPrivkey(sk(150)), 'signet');
export const FUND_TXID = 'aa'.repeat(32);
export const AMOUNT = 500_000;

// ── 하네스 ──────────────────────────────────────────────────

export interface OcHarness extends LnHarness {
  chain: FakeChain;
  oc: OcContext;
  row(orderId: string): OcRow | undefined;
}

/**
 * 온체인 하네스. 새 의뢰를 받게 켜 두고, 재시작 워밍업(2분)을 넘긴다. 수수료는 첫 틱에 받는다.
 */
export async function createOcHarness(): Promise<OcHarness> {
  let chain!: FakeChain;
  const h = await createLnHarness({
    onchain: () => {
      chain = new FakeChain();
      return { chain, network: 'signet', pollMs: 0 };
    },
  });
  const s = loadSettings(h.ln.db);
  saveSettings(h.ln.db, { ...s, onchain: { acceptNewOrders: true } });
  h.advance(5 * 60);
  await h.run(1);
  const oc = h.daemon.onchain!.ctx;
  return { ...h, chain, oc, row: id => getOc(oc, id) };
}

export function ocRequest(
  from: TestKey, appPubkey: string, orderId: string, action: string, createdAt: number,
  extra: string[][] = [], content = '', expiration = onchainMessageExpiration(createdAt),
): Event {
  return finalizeEvent({
    kind: MESSAGE_KIND,
    created_at: createdAt,
    tags: [
      ['a', orderRef(appPubkey, orderId)],
      ['action', action],
      ['t', TEST_TAGS.onchain],
      ['p', appPubkey],
      ['expiration', String(expiration)],
      ...extra,
    ],
    content,
  }, from.secretKey);
}

/** 이 사람에게 간 APP 메시지 (온체인) */
export function ocMessagesTo(h: OcHarness, pubkey: string, action: string): Event[] {
  return h.relay.published.filter(e =>
    e.pubkey === h.app.pubkey
    && e.tags.some(t => t[0] === 't' && t[1] === TEST_TAGS.onchain)
    && e.tags.some(t => t[0] === 'p' && t[1] === pubkey)
    && e.tags.some(t => t[0] === 'action' && t[1] === action));
}

export function rejectionsTo(h: OcHarness, pubkey: string): string[] {
  return ocMessagesTo(h, pubkey, REQUEST_ACTIONS.ONCHAIN_REJECTED).map(e => tagOf(e, 'reason') ?? '');
}

export function descriptorOf(h: OcHarness, orderId: string): EscrowDescriptor {
  const o = h.row(orderId)!.order;
  return deriveEscrowAddress({
    keys: { customer: o.customerXonly!, sponsor: o.sponsorXonly!, admin: o.adminXonly! },
    network: 'signet', timelockBlocks: o.timelockBlocks,
  });
}

let seq = 0;

/** 의뢰 등록 → 보증금 결제 → `listed` */
export async function openOc(
  h: OcHarness, opts: { orderId?: string; amountSat?: number; listingSec?: number; reserveKrw?: number; refund?: string } = {},
): Promise<string> {
  const orderId = opts.orderId ?? `oc${(seq++).toString(36)}xx`;
  const extra: string[][] = [
    ['amount-sat', String(opts.amountSat ?? AMOUNT)],
    ['customer-xonly', XC],
    ...(opts.reserveKrw !== undefined ? [['reserve-krw', String(opts.reserveKrw)]] : []),
  ];
  // 의뢰 만료가 곧 이 요청의 만료다 (유저 앱 규약)
  await h.send(ocRequest(h.customer, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_ORDER_REQUEST, h.sec(), extra,
    nip44Encrypt(JSON.stringify({ refundAddress: opts.refund ?? REFUND }), h.customer.secretKey, h.app.pubkey),
    h.sec() + (opts.listingSec ?? 3 * 86_400)));
  const required = ocMessagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED).at(-1);
  if (required && !h.row(orderId)) {
    h.node.pay(tagOf(required, 'bolt11')!);
    await h.run();
  }
  return orderId;
}

/** 클레임 → 보증금 결제 → `bonded` */
export async function claimOc(
  h: OcHarness, orderId: string, opts: { sponsor?: TestKey; pay?: boolean; payout?: string; feerate?: number } = {},
): Promise<void> {
  const sponsor = opts.sponsor ?? h.sponsor;
  await h.send(ocRequest(sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_CLAIM, h.sec(), [['sponsor-xonly', XS]],
    nip44Encrypt(JSON.stringify({ payoutAddress: opts.payout ?? PAYOUT, feerateSatPerVb: opts.feerate ?? 2 }), sponsor.secretKey, h.app.pubkey)));
  if (opts.pay === false) return;
  const required = ocMessagesTo(h, sponsor.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED).at(-1);
  if (!required) return;
  h.node.pay(tagOf(required, 'bolt11')!);
  await h.run();
}

/** 펀딩 컨펌 → `funded` */
export async function fundOc(h: OcHarness, orderId: string, confirmations = 3): Promise<void> {
  h.chain.fund(h.row(orderId)!.order.escrowAddress!, { txid: FUND_TXID, vout: 0, valueSat: h.row(orderId)!.order.amountSat, confirmations });
  await h.run();
}

/** 후원자 사전서명 */
export async function presignOc(h: OcHarness, orderId: string, feeSat?: number): Promise<void> {
  const o = h.row(orderId)!.order;
  const tx = buildSettlementTx({
    descriptor: descriptorOf(h, orderId),
    input: { outpoint: { txid: FUND_TXID, vout: 0 }, valueSat: o.amountSat },
    path: 'release', destination: PAYOUT, feeSat: feeSat ?? o.releaseFeeSat!,
  });
  signSettlement(tx, SK_S);
  await h.send(ocRequest(h.sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_PRESIG, h.sec(), [],
    nip44Encrypt(JSON.stringify({ psbt: toPsbtBase64(tx) }), h.sponsor.secretKey, h.app.pubkey)));
}

export async function sendAccountOc(h: OcHarness, orderId: string, from: TestKey = h.customer): Promise<void> {
  await h.send(ocRequest(from, h.app.pubkey, orderId, REQUEST_ACTIONS.ACCOUNT_INFO, h.sec(),
    [['p', h.sponsor.pubkey], ['commitment', 'ab'.repeat(32)]], 'ciphertext'));
}

export async function remitOc(h: OcHarness, orderId: string, from: TestKey = h.sponsor): Promise<void> {
  await h.send(ocRequest(from, h.app.pubkey, orderId, REQUEST_ACTIONS.REMIT_REQUEST, h.sec()));
}

/** 가장 최근 서명 요청 (APP → 그 사람) */
export function lastSignRequest(h: OcHarness, to: TestKey): { purpose: string; psbt: string } | undefined {
  const e = ocMessagesTo(h, to.pubkey, REQUEST_ACTIONS.ONCHAIN_COSIGN).sort((a, b) => a.created_at - b.created_at).at(-1);
  if (!e) return undefined;
  return {
    purpose: tagOf(e, 'purpose')!,
    psbt: (JSON.parse(nip44Decrypt(e.content, to.secretKey, h.app.pubkey)) as { psbt: string }).psbt,
  };
}

/** 받은 서명 요청에 서명해 돌려보낸다 */
export async function cosignOc(
  h: OcHarness, orderId: string, who: TestKey, orderKey: Uint8Array,
  purpose: 'release' | 'refund' | 'dispute-sponsor' | 'dispute-customer' | 'rescue',
): Promise<void> {
  const req = lastSignRequest(h, who);
  if (!req) throw new Error('서명 요청이 없다');
  const tx = fromPsbtBase64(req.psbt);
  signSettlement(tx, orderKey);
  await h.send(ocRequest(who, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_COSIGN, h.sec(), [['purpose', purpose]],
    nip44Encrypt(JSON.stringify({ psbt: toPsbtBase64(tx) }), who.secretKey, h.app.pubkey)));
}

/** 우리가 뿌린 종결 tx를 컨펌시킨다 */
export async function confirmSettlementOc(h: OcHarness, orderId: string, confirmations = 3): Promise<void> {
  const txid = h.row(orderId)!.order.settlementTxid!;
  h.chain.confirm(txid, confirmations);
  await h.run();
}

/** 끝까지: 등록 → 클레임 → 펀딩 → 사전서명 → 계좌 → 송금 완료 */
export async function toRemittedOc(h: OcHarness, opts: { listingSec?: number } = {}): Promise<string> {
  const orderId = await openOc(h, opts);
  await claimOc(h, orderId);
  await fundOc(h, orderId);
  await presignOc(h, orderId);
  await sendAccountOc(h, orderId);
  await remitOc(h, orderId);
  return orderId;
}
