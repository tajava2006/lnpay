/**
 * 라이트닝 오더 이벤트 (`ORDER_KIND`) — 만들기와 읽기를 한 곳에
 *
 * ── 거래 마감과 이벤트 보존을 가른다 (DM-009)
 *
 * 예전에는 `expiration` 태그 하나가 둘을 겸했다:
 *
 * - **쿠팡 가상계좌 기한** — 원화를 보낼 수 있는 마지막 시각(유저스크립트가 쿠팡에서 읽어 온다)
 * - **NIP-40 보존 기한** — 릴레이가 이 이벤트를 지우는 시각
 *
 * 거래는 기한 뒤에도 이어진다(송금 완료 버튼, 입금 확인, 분쟁). 그런데 기한 = 보존이라 그 순간
 * 릴레이가 발행을 거절했고, 앱들은 상태와 무관하게 오더를 지웠다. 이제:
 *
 * - `deadline` 태그 = 쿠팡 기한 (화면의 카운트다운·오더북 필터)
 * - `expiration` 태그 = 보존 (`lnRetention` — 진행 중이면 넉넉히 늘린다)
 *
 * 읽을 때 `Order.expiration`은 **거래 마감**으로 채운다 — 화면 코드가 이미 그 뜻으로 쓰고 있다.
 * 보존은 `Order.retainUntil`로 따로 준다(목록에서 지울 때만 쓴다).
 */
import type { Event } from 'nostr-tools/core';
import { isTerminalState, type OrderState } from '../constants';
import { nip69Tags, type Nip69Status } from '../nip69';
import type { Order } from '../types';

/** 종결된 오더가 릴레이에 남는 기간 — 양쪽이 결과를 한 번은 보게 */
export const LN_TERMINAL_RETENTION_SEC = 7 * 24 * 60 * 60;

/** 진행 중 오더의 보존 — 에스크로 CLTV(최대 ~3일) + 분쟁보다 넉넉히 */
export const LN_ACTIVE_RETENTION_SEC = 30 * 24 * 60 * 60;

/**
 * 요청 이벤트(`MESSAGE_KIND`)의 보존. 거래 마감을 쓰면 **마감 직후의 송금 완료·입금 확인이 릴레이에서
 * 거절된다** — 그 요청들이 제일 중요한 순간이다. 데몬이 잠시 꺼져 있어도 받게 일주일.
 */
export const LN_REQUEST_RETENTION_SEC = 7 * 24 * 60 * 60;

export function lnRequestExpiration(nowSec: number): number {
  return nowSec + LN_REQUEST_RETENTION_SEC;
}

/**
 * 쿠팡 기한이 이만큼 안 남은 의뢰는 클레임을 받지 않는다 — 결제·인보이스·계좌·송금이 들어갈 틈이 없다.
 * 데몬이 거절하고, 유저 앱은 오더북에서 미리 감춘다(같은 값이어야 한다).
 */
export const LN_MIN_CLAIM_LEAD_SEC = 60 * 60;

/**
 * 받는 쿠팡 기한의 상한. 홀드 인보이스 CLTV가 전부 기한에서 나오므로, 기한이 멀면 결제자 쪽 CLTV
 * 상한(LND 기본 2016블록)을 넘어 결제 자체가 안 된다. 7일이면 가장 긴 후원자 보증금이 ~1450블록이다.
 */
export const LN_MAX_DEADLINE_LEAD_SEC = 7 * 24 * 60 * 60;

/**
 * 후원자가 낼 지급 인보이스의 최소 잔여 수명 — 원화 송금과 입금 확인이 그 안에 들어가야 한다.
 * 데몬이 거절하고, 유저 앱은 입력 폼에서 미리 거른다(같은 값이어야 한다).
 */
export const LN_MIN_SPONSOR_INVOICE_LIFETIME_SEC = 6 * 60 * 60;

/** 오더북에서 클레임할 수 있는 의뢰인가 */
export function isClaimableLn(order: Pick<Order, 'state' | 'expiration'>, nowSec: number): boolean {
  return order.state === 'requested' && order.expiration - nowSec >= LN_MIN_CLAIM_LEAD_SEC;
}

export function lnRetention(state: OrderState, deadline: number, nowSec: number): number {
  if (state === 'requested') return deadline; // 오더북에서 저절로 사라져야 한다
  if (isTerminalState(state)) return nowSec + LN_TERMINAL_RETENTION_SEC;
  return Math.max(deadline, nowSec) + LN_ACTIVE_RETENTION_SEC;
}

export interface LnOrderFields {
  orderId: string;
  state: OrderState;
  customerPubkey: string;
  sponsorPubkey?: string;
  price: number;
  /** 쿠팡 가상계좌 기한 (unix초) */
  deadline: number;
  bolt11?: string;
  payoutSat?: number;
  sponsorInvoice?: string;
  disbursed?: boolean;
  depositPaymentHash?: string;
  sponsorDepositPaymentHash?: string;
  /**
   * 클레임은 됐지만 후원자 보증금을 아직 안 냈다. 보증금이 들어오거나(`sponsorDepositPaymentHash`) 클레임이
   * 풀리기 전까지 거래는 **아직 후원자를 찾는 중**이다 — 양쪽 화면이 이걸로 진행도와 배지를 그린다
   */
  sponsorDepositPending?: boolean;
  /** 종결 사유 (`LnCloseReason`) — 화면이 "왜 끝났는지"를 말하게 */
  closeReason?: string;
}

/**
 * 라이트닝 상태 → NIP-69 상태. 후원자 승은 원화가 갔고 후원자가 sats를 받았으니 성사다.
 * `claimed`는 후원자 보증금 대기로 다시 `requested`에 돌아올 수 있지만, 테이커가 붙은 동안은 진행 중이다.
 */
const LN_NIP69_STATUS: Record<OrderState, Nip69Status> = {
  requested: 'pending',
  claimed: 'in-progress',
  verified: 'in-progress',
  escrowed: 'in-progress',
  invoiced: 'in-progress',
  remitted: 'in-progress',
  paid: 'success',
  sponsor_wins: 'success',
  customer_wins: 'canceled',
  cancelled: 'canceled',
  admin_closed: 'canceled',
  expired: 'expired',
};

export function lnOrderTags(order: LnOrderFields, clientTag: string, retainUntil: number): string[][] {
  const tags: string[][] = [
    ['d', order.orderId],
    ['t', clientTag],
    ['state', order.state],
    ['price', String(order.price), 'KRW'],
    ['customer', order.customerPubkey],
    ['deadline', String(order.deadline)],
    ['expiration', String(retainUntil)],
  ];
  if (order.sponsorPubkey) tags.push(['sponsor', order.sponsorPubkey]);
  if (order.bolt11) tags.push(['bolt11', order.bolt11]);
  if (order.payoutSat) tags.push(['payout', String(order.payoutSat)]);
  if (order.sponsorInvoice) tags.push(['sponsor-invoice', order.sponsorInvoice]);
  if (order.disbursed) tags.push(['disbursed', 'true']);
  if (order.depositPaymentHash) tags.push(['customer-deposit-payment-hash', order.depositPaymentHash]);
  if (order.sponsorDepositPaymentHash) tags.push(['sponsor-deposit-payment-hash', order.sponsorDepositPaymentHash]);
  if (order.sponsorDepositPending) tags.push(['sponsor-deposit', 'pending']);
  if (order.closeReason) tags.push(['close-reason', order.closeReason]);
  // 라이트닝은 늘 mainnet이다 — dev 데몬도 운영 LND를 같이 쓴다
  return [...tags, ...nip69Tags({
    status: LN_NIP69_STATUS[order.state],
    amountSat: order.payoutSat ?? 0,
    fiatKrw: order.price,
    network: 'mainnet',
    layer: 'lightning',
    expiresAt: order.deadline,
  })];
}

const tag = (event: Pick<Event, 'tags'>, name: string) => event.tags.find(t => t[0] === name)?.[1];

/**
 * 오더 이벤트를 읽는다. **APP이 서명한 것만** — 누구나 같은 kind를 낼 수 있다.
 * `deadline`이 없으면 0(지난 것)으로 읽는다 — 모르는 마감을 먼 마감으로 믿지 않는다.
 */
export function parseLnOrderEvent(event: Event, appPubkey: string): Order | null {
  if (event.pubkey !== appPubkey) return null;
  const orderId = tag(event, 'd');
  if (!orderId) return null;

  const retainUntil = Number(tag(event, 'expiration') ?? 0);
  const deadline = Number(tag(event, 'deadline') ?? 0);
  const payoutSat = Number(tag(event, 'payout') ?? 0);
  const sponsorPubkey = tag(event, 'sponsor');
  const bolt11 = tag(event, 'bolt11');
  const sponsorInvoice = tag(event, 'sponsor-invoice');
  const depositPaymentHash = tag(event, 'customer-deposit-payment-hash');
  const sponsorDepositPaymentHash = tag(event, 'sponsor-deposit-payment-hash');
  const closeReason = tag(event, 'close-reason');

  return {
    orderId,
    state: (tag(event, 'state') ?? 'requested') as OrderState,
    customerPubkey: tag(event, 'customer') ?? '',
    ...(sponsorPubkey ? { sponsorPubkey } : {}),
    ...(bolt11 ? { bolt11 } : {}),
    ...(tag(event, 'disbursed') === 'true' ? { disbursed: true } : {}),
    ...(depositPaymentHash ? { depositPaymentHash } : {}),
    ...(sponsorDepositPaymentHash ? { sponsorDepositPaymentHash } : {}),
    ...(tag(event, 'sponsor-deposit') === 'pending' ? { sponsorDepositPending: true } : {}),
    ...(payoutSat > 0 ? { payoutSat } : {}),
    ...(sponsorInvoice ? { sponsorInvoice } : {}),
    ...(closeReason ? { closeReason } : {}),
    price: Number(tag(event, 'price') ?? 0),
    createdAt: event.created_at,
    updatedAt: event.created_at,
    expiration: Number.isFinite(deadline) ? deadline : 0,
    ...(retainUntil > 0 ? { retainUntil } : {}),
    raw: event,
  };
}
