/**
 * 온체인 오더 이벤트 규약 (PLAN-ONCHAIN-TRACK §5.1)
 *
 * kind 30402를 `CLIENT_TAG_ONCHAIN`으로 발행한다. **라이트닝과 태그가 겹치면
 * 배포 사고가 난다**(§1.3) — 구버전 앱이 온체인 오더를 라이트닝 오더로 렌더링한다.
 *
 * ── 직렬화와 파싱을 한 파일에 둔 이유
 *
 * 어드민이 쓰고 클라이언트가 읽는다. 두 군데로 갈라두면 태그 하나를 추가할 때
 * 한쪽만 고치게 되고, 그 사고를 이 레포는 이미 여러 번 겪었다.
 * **왕복 테스트**(직렬화 → 파싱 → 같은 값)가 그걸 잡는다.
 *
 * ── 공개하지 않는 것
 *
 * **후원자의 받을 주소와 희망 feerate는 여기 없다.** 파생 키와 달리 그건
 * 후원자의 **실제 지갑 주소**라, 공개하면 제3자가 그 지갑을 따라갈 수 있다.
 * 사전서명 PSBT 안에 실려 어드민·고객에게만 간다 (§3.2 말미).
 */
import type { OnchainState, SettlementKind } from './state-machine';
import { ONCHAIN_STATES, SETTLEMENT_KINDS, isOnchainTerminal } from './state-machine';
import type { BtcNetworkName } from './address';
import { isXonlyHex } from './hex';

export interface OnchainOrder {
  orderId: string;
  state: OnchainState;
  /** NIP-99 listing status. 터미널이면 `sold` */
  status: 'active' | 'sold';
  /** 고객의 앱 키 (nostr pubkey) */
  customerPubkey: string;
  /** 후원자의 앱 키. `bonded` 이후 */
  sponsorPubkey?: string;
  /** 고객이 파는 수량 */
  amountSat: number;
  /** 최저 수용 KRW (선택). 없으면 시장가 */
  reserveKrw?: number;
  createdAt: number;
  updatedAt: number;
  /** 의뢰 만료 (unix초) */
  expiration: number;
  network: BtcNetworkName;

  // ── bonded 이후: 에스크로가 확정된다 ──
  customerXonly?: string;
  sponsorXonly?: string;
  adminXonly?: string;
  escrowAddress?: string;
  timelockBlocks?: number;
  /**
   * 고객 펀딩 마감 (unix초). **컨펌까지** 끝나야 하는 시각이다(§4.1c).
   * 리오그로 `bonded`에 돌아오면 **다시 찍는다** — 안 그러면 체인 사고로
   * 정직한 고객이 몰수된다.
   */
  fundingDeadline?: number;

  // ── funded 이후: 가격이 고정된다 ──
  /** `txid:vout`. 종결 tx가 소모할 대상 */
  fundingOutpoint?: string;
  fundingConfs?: number;
  /** T0 = `funded` 진입 시각 */
  fundedAt?: number;
  priceKrw?: number;
  payoutSat?: number;
  releaseFeeSat?: number;

  // ── presigned 이후 ──
  presignedAt?: number;
  /** 고객이 계좌를 공개한 시각. **후원자 송금 마감의 기준**이다 (O-013) */
  accountSentAt?: number;
  /** 원화 송금 마감 (unix초) */
  krwDeadline?: number;

  // ── remitted 이후 ──
  /** 가격 유효창(O-016)과 cosign 마감의 기준 */
  remittedAt?: number;

  /**
   * 후원자가 송금 마감 **전에** "계좌를 쓸 수 없다"고 이의를 낸 시각 (§5.2b).
   * 상태가 아니라 증거다 — 시계를 멈추지 않는다. 마감이 차면 환불 사유가
   * `refund:account-disputed`(잠정)가 되고 어드민이 과실을 판정한다.
   */
  accountDisputedAt?: number;

  // ── remitted → disputed ──
  /** 분쟁 진입 시각. 에스컬레이션 시계의 기준이다(`updatedAt`은 재발행마다 바뀐다) */
  disputedAt?: number;

  // ── 종결 결정 (refunding · 분쟁 판정) ──
  /**
   * 종결 사유. `refunding`과 판정이 난 `disputed`에서는 **결정**이고, `settling`
   * 이후에는 브로드캐스트된 tx의 사유다.
   *
   * 결정을 오더 이벤트에 싣는 이유(리뷰 #8): 사이드 스토어에만 두면 기기를 옮기거나
   * 저장소가 날아갈 때 결정이 사라지고, 새 기기가 **다른 사유**로 다시 결정한다
   * (reserve 미달로 접은 주문이 후원자 이탈로 재판정돼 후원자가 부당하게 몰수됐다).
   */
  settlementKind?: SettlementKind;
  /**
   * 결정된 종결 tx의 수수료(sat). 사유·수수료·받는 주소가 정해지면 tx가 **한 바이트까지**
   * 정해지므로, 어느 기기에서든 같은 tx를 다시 만들 수 있다.
   */
  settlementFeeSat?: number;
  /** 결정 시각 — 보증금은 이때 처리된다 */
  decidedAt?: number;
  settlementTxid?: string;
  /** 종결 tx를 뿌린 시각. 24시간 넘게 안 잡히면 CPFP 안내를 띄운다 (§6.2) */
  settlingAt?: number;

  // ── 보증금 (LN 홀드 인보이스) ──
  customerDepositHash?: string;
  sponsorDepositHash?: string;

  raw: object;
}

type TagList = string[][];

function num(tags: TagList, name: string, value: number | undefined): void {
  if (value !== undefined) tags.push([name, String(value)]);
}
function str(tags: TagList, name: string, value: string | undefined): void {
  if (value) tags.push([name, value]);
}

/**
 * 오더 → kind 30402 태그. `d`·`t`·`status`·`state`는 언제나 실린다.
 *
 * `clientTag`를 인자로 받는 이유: `CLIENT_TAG_ONCHAIN`이 dev/prod로 갈리는데
 * 그 판단은 앱의 환경 변수 몫이고, 이 함수는 순수하게 유지해야 테스트가 쉽다.
 */
export function onchainOrderTags(order: OnchainOrder, clientTag: string): TagList {
  const tags: TagList = [
    ['d', order.orderId],
    ['t', clientTag],
    ['status', isOnchainTerminal(order.state) ? 'sold' : 'active'],
    ['state', order.state],
    ['network', order.network],
    ['customer', order.customerPubkey],
    ['amount-sat', String(order.amountSat)],
    ['expiration', String(order.expiration)],
  ];

  str(tags, 'sponsor', order.sponsorPubkey);
  num(tags, 'reserve-krw', order.reserveKrw);

  str(tags, 'customer-xonly', order.customerXonly);
  str(tags, 'sponsor-xonly', order.sponsorXonly);
  str(tags, 'admin-xonly', order.adminXonly);
  str(tags, 'escrow-address', order.escrowAddress);
  num(tags, 'timelock-blocks', order.timelockBlocks);
  num(tags, 'funding-deadline', order.fundingDeadline);

  str(tags, 'funding-outpoint', order.fundingOutpoint);
  num(tags, 'funding-confs', order.fundingConfs);
  num(tags, 'funded-at', order.fundedAt);
  num(tags, 'price-krw', order.priceKrw);
  num(tags, 'payout-sat', order.payoutSat);
  num(tags, 'release-fee-sat', order.releaseFeeSat);

  num(tags, 'presigned-at', order.presignedAt);
  num(tags, 'account-sent-at', order.accountSentAt);
  num(tags, 'krw-deadline', order.krwDeadline);
  num(tags, 'remitted-at', order.remittedAt);
  num(tags, 'account-disputed-at', order.accountDisputedAt);
  num(tags, 'disputed-at', order.disputedAt);

  str(tags, 'settlement-kind', order.settlementKind);
  num(tags, 'settlement-fee-sat', order.settlementFeeSat);
  num(tags, 'decided-at', order.decidedAt);
  str(tags, 'settlement-txid', order.settlementTxid);
  num(tags, 'settling-at', order.settlingAt);

  str(tags, 'customer-deposit-payment-hash', order.customerDepositHash);
  str(tags, 'sponsor-deposit-payment-hash', order.sponsorDepositHash);

  return tags;
}

/** 파싱에 필요한 이벤트의 최소 모양 (nostr-tools 타입에 묶이지 않게) */
export interface OnchainOrderEvent {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content?: string;
}

const KNOWN_STATES = new Set<string>(Object.values(ONCHAIN_STATES));
const KNOWN_KINDS = new Set<string>(Object.values(SETTLEMENT_KINDS));
const KNOWN_NETWORKS = new Set<string>(['mainnet', 'signet', 'testnet', 'regtest']);

function tagValue(tags: TagList, name: string): string | undefined {
  return tags.find(t => t[0] === name)?.[1];
}

function readNum(tags: TagList, name: string): number | undefined {
  const raw = tagValue(tags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * kind 30402 → 오더. **모르는 모양이면 `null`이다.**
 *
 * 릴레이에서 오는 건 남이 만든 바이트다. 상태 문자열 하나가 모르는 값이면
 * (새 버전 클라이언트가 발행한 것일 수 있다) 추측하지 않고 버린다 —
 * 모르는 상태를 아는 척하면 화면이 거짓말을 한다.
 */
export function parseOnchainOrder(
  event: OnchainOrderEvent,
  clientTag: string,
): OnchainOrder | null {
  const tags = event.tags;
  if (tagValue(tags, 't') !== clientTag) return null;

  const orderId = tagValue(tags, 'd');
  const state = tagValue(tags, 'state');
  const customerPubkey = tagValue(tags, 'customer');
  const network = tagValue(tags, 'network');
  const amountSat = readNum(tags, 'amount-sat');

  if (!orderId || !customerPubkey) return null;
  if (!state || !KNOWN_STATES.has(state)) return null;
  if (!network || !KNOWN_NETWORKS.has(network)) return null;
  if (amountSat === undefined || !Number.isInteger(amountSat) || amountSat <= 0) return null;

  // x-only 키는 형식이 틀리면 주소 파생이 엉뚱해진다. 여기서 거른다.
  for (const name of ['customer-xonly', 'sponsor-xonly', 'admin-xonly'] as const) {
    const v = tagValue(tags, name);
    if (v !== undefined && !isXonlyHex(v)) return null;
  }

  // 사유는 서명할 tx를 정한다 — 모르는 값을 아는 척하면 엉뚱한 tx에 서명하게 된다.
  const settlementKind = tagValue(tags, 'settlement-kind');
  if (settlementKind !== undefined && !KNOWN_KINDS.has(settlementKind)) return null;

  return {
    orderId,
    state: state as OnchainState,
    status: isOnchainTerminal(state as OnchainState) ? 'sold' : 'active',
    customerPubkey,
    sponsorPubkey: tagValue(tags, 'sponsor'),
    amountSat,
    reserveKrw: readNum(tags, 'reserve-krw'),
    createdAt: event.created_at,
    updatedAt: event.created_at,
    expiration: readNum(tags, 'expiration') ?? 0,
    network: network as BtcNetworkName,

    customerXonly: tagValue(tags, 'customer-xonly'),
    sponsorXonly: tagValue(tags, 'sponsor-xonly'),
    adminXonly: tagValue(tags, 'admin-xonly'),
    escrowAddress: tagValue(tags, 'escrow-address'),
    timelockBlocks: readNum(tags, 'timelock-blocks'),
    fundingDeadline: readNum(tags, 'funding-deadline'),

    fundingOutpoint: tagValue(tags, 'funding-outpoint'),
    fundingConfs: readNum(tags, 'funding-confs'),
    fundedAt: readNum(tags, 'funded-at'),
    priceKrw: readNum(tags, 'price-krw'),
    payoutSat: readNum(tags, 'payout-sat'),
    releaseFeeSat: readNum(tags, 'release-fee-sat'),

    presignedAt: readNum(tags, 'presigned-at'),
    accountSentAt: readNum(tags, 'account-sent-at'),
    krwDeadline: readNum(tags, 'krw-deadline'),
    remittedAt: readNum(tags, 'remitted-at'),
    accountDisputedAt: readNum(tags, 'account-disputed-at'),
    disputedAt: readNum(tags, 'disputed-at'),

    settlementKind: settlementKind as SettlementKind | undefined,
    settlementFeeSat: readNum(tags, 'settlement-fee-sat'),
    decidedAt: readNum(tags, 'decided-at'),
    settlementTxid: tagValue(tags, 'settlement-txid'),
    settlingAt: readNum(tags, 'settling-at'),

    customerDepositHash: tagValue(tags, 'customer-deposit-payment-hash'),
    sponsorDepositHash: tagValue(tags, 'sponsor-deposit-payment-hash'),

    raw: event as object,
  };
}

/** `txid:vout` 문자열 ↔ outpoint */
export function formatOutpoint(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

export function parseOutpoint(value: string | undefined): { txid: string; vout: number } | null {
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length !== 2) return null;
  const [txid, voutRaw] = parts as [string, string];
  if (!/^[0-9a-f]{64}$/.test(txid)) return null;
  // ⚠️ `Number('')`은 0이다. 빈 문자열을 그냥 넘기면 `txid:`가 **0번 출력**으로
  // 읽혀 엉뚱한 UTXO를 소모하려 든다. 숫자만 있는지 먼저 본다.
  if (!/^\d+$/.test(voutRaw)) return null;
  const vout = Number(voutRaw);
  if (!Number.isSafeInteger(vout)) return null;
  return { txid, vout };
}

/**
 * 이 상태에서 **반드시 있어야 하는 값이 비었는지** 본다.
 *
 * kind 30402는 addressable이라 새 발행이 이전 이벤트를 **덮어쓴다.** 한 번 빠진
 * 태그는 영영 복구되지 않는다 — 라이트닝 트랙에서 `payoutSat` 없이 발행해
 * 주문 두 건을 그렇게 잃었다(2026-09-19).
 *
 * 발행을 막지는 않는다(멈추면 거래가 더 크게 망가진다). 호출부가 **크게 남긴다.**
 */
export function onchainOrderIssues(order: OnchainOrder): string[] {
  const issues: string[] = [];
  const need = (cond: unknown, what: string) => {
    if (!cond) issues.push(what);
  };

  const afterBonded = order.state !== 'listed' && order.state !== 'cancelled';
  if (afterBonded) {
    need(order.sponsorPubkey, 'sponsor');
    need(order.customerXonly && order.sponsorXonly && order.adminXonly, 'xonly 3종');
    need(order.escrowAddress, 'escrow-address');
    need(order.timelockBlocks, 'timelock-blocks');
  }

  // 펀딩 outpoint는 가격 고정 여부와 무관하게 에스크로를 소모하는 모든 상태에 필요하다
  // (`bonded → refunding`으로 접는 경우는 가격이 없다).
  const pinned = order.state !== 'listed' && order.state !== 'bonded' && order.state !== 'cancelled';
  if (pinned) need(order.fundingOutpoint, 'funding-outpoint');

  // 가격이 고정된 거래 — 원화가 오갈 수 있는 상태들
  const priced = order.state === 'funded' || order.state === 'presigned'
    || order.state === 'remitted' || order.state === 'disputed' || order.state === 'released';
  if (priced) {
    need(order.priceKrw, 'price-krw');
    need(order.payoutSat, 'payout-sat');
    need(order.fundedAt, 'funded-at');
  }

  if (order.state === 'refunding') {
    need(order.settlementKind, 'settlement-kind');
    need(order.settlementFeeSat !== undefined, 'settlement-fee-sat');
  }

  if (order.state === 'disputed' && order.settlementKind) {
    need(order.settlementFeeSat !== undefined, 'settlement-fee-sat');
  }

  if (order.state === 'settling') {
    need(order.settlementKind, 'settlement-kind');
    need(order.settlementTxid, 'settlement-txid');
  }

  return issues;
}
