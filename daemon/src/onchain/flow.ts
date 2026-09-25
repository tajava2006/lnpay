/**
 * 온체인 요청 처리와 종결 결정
 *
 * 사람이 미는 쪽이다 — 의뢰 등록, 클레임, 사전서명, 최종 서명, 송금 주장, 분쟁, 구조. 체인이 미는 쪽은
 * `watcher.ts`가 맡는다. 규칙은 docs/ONCHAIN-TRACK.md.
 *
 * - **트랜잭션 안에서, 네트워크 없이** 판단한다. 수수료는 워처가 받아 둔 값(`fees.ts`), 보증금 인보이스는
 *   계획만 하고 노드 호출은 효과가 한다(`../hold`), 브로드캐스트도 효과다.
 * - **어드민 키는 시드 파생**이다(DM-005).
 * - **outbox와 `settling`을 한 트랜잭션에 쓴다**(O-019). 장부가 먼저 알고, 뿌리는 건 그 뒤의 효과다.
 * - **어드민은 언제나 마지막에 서명한다**(O-018). 서명할 쪽에는 서명 없는 PSBT가 가고, 그 서명을 검증한 뒤
 *   데몬이 서명해 직접 뿌린다 — 고객 손에 완성 가능한 환불이 들리지 않는다. (릴리스는 어드민 키가 없다.)
 * - **결정은 상태다**(O-017). 환불이 결정되면 `refunding` — 늦은 사전서명·계좌·송금 주장은 전부 거절된다.
 * - **누가 보냈는지 본다**(O-020).
 */
import {
  REQUEST_ACTIONS, extractOrderId, nip44Decrypt,
} from '@sajwo-tracker/shared/core';
import {
  TYPICAL_SETTLEMENT_VSIZE,
  accountDeadlineFrom, accountDeadlineOf, addTapScriptSig, addressProblem, awaitingSignerFor, buildSettlementTx, bytesToHex,
  canActOnSignRequest, deriveEscrowAddress, dustThresholdFor, finalizeSettlement, formatOutpoint, fromPsbtBase64,
  isOnchainClaimPayload, isOnchainOrderRequestPayload, isOnchainPsbtPayload, isOnchainTerminal, isOrderExpiryAllowed,
  cosignDeadlineFrom, isPast, isRefundKind, isXonlyHex, krwDeadlineFrom, krwDeadlineOf, parseOutpoint, presignDeadlineOf,
  releaseFeerateProblem, reserveProblem, settlementFeeSat, signPurposeFor, signSettlement, toPsbtBase64,
  verifyPresignature,
  type EscrowDescriptor, type OnchainOrder, type Outpoint, type SettlementKind, type SignPurpose,
} from '@sajwo-tracker/shared/onchain';
import { raiseAlert } from '../admin/alerts';
import { nowSec } from '../admin/context';
import { loadSettings } from '../admin/settings';
import { tagValue, type HandlerResult, type InboxEvent } from '../dispatch';
import { CLTV_MAX_BLOCKS } from '../ln/timing';
import { isOrderId } from '../orders/id';
import { applyOutcome, dropSponsorCandidates } from './bonds';
import type { OcContext } from './context';
import {
  CUSTOMER_DEPOSIT_PERCENT, SPONSOR_DEPOSIT_PERCENT, depositCltvBlocks, depositFloorSat, depositSat, minTradeSat,
} from './deposit';
import { adminKeyOf, escrowDescriptorFor, refundDestinationFor, settlementParamsFor } from './escrow';
import { currentFees } from './fees';
import { sendOcRejected, sendOcSignRequest } from './messages';
import { notifyOcAccountArrived, notifyOcRuling, notifyOcTransition } from './notify';
import {
  candidatesOf, deleteCandidate, getOc, putCandidate, updateOc, updateOcMeta,
  type OcPatch, type OcRow, type OcUtxo,
} from './store';

export const OC_BROADCAST_EFFECT = 'oc.broadcast';

export interface BroadcastPayload {
  orderId: string;
  txid: string;
  /** 구조 tx면 `txid:vout` (meta.rescues의 키) */
  rescueKey?: string;
}

/**
 * 한 의뢰에 동시에 띄워 둘 수 있는 후원자 보증금 인보이스 수. 클레임은 상태를 안 바꾸고 인보이스만 내주므로
 * 아무나 몇 번이든 부를 수 있다 — 돈 문제가 아니라 노드·릴레이를 태우는 위생 문제라 상한 하나로 끝낸다.
 */
const MAX_CLAIM_CANDIDATES = 5;

const ignored = (reason: string): HandlerResult => ({ outcome: 'ignored', reason });
const ok: HandlerResult = { outcome: 'ok' };

/**
 * 거절을 **유저에게 도달시킨다.** 콘솔 로그로 끝내면 "보냈는데 아무 일도 안 일어난다"가 된다.
 */
function reject(ctx: OcContext, orderId: string, event: InboxEvent, reason: string): HandlerResult {
  sendOcRejected(ctx, orderId, event.pubkey, reason, event.id);
  return ignored('rejected');
}

function decrypt(ctx: OcContext, event: InboxEvent): unknown {
  try {
    return JSON.parse(nip44Decrypt(event.content, ctx.appKey.secretKey, event.pubkey)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 마감을 볼 때의 "요청 시각". **요청이 만들어진 시각**을 쓴다(미래로는 못 간다) — 데몬이 잠깐 꺼져 있던 사이
 * 마감 안에 보낸 요청이 늦게 처리돼도 정직한 쪽이 몰수되지 않게. 이미 결정된 거래는 상태 확인이 먼저 막는다.
 */
function requestAt(ctx: OcContext, event: InboxEvent): number {
  return Math.min(event.created_at, nowSec(ctx));
}

function anomaly(ctx: OcContext, orderId: string, message: string): void {
  raiseAlert(ctx, { dedup: `oc:${orderId}:anomaly:${message}`, level: 'anomaly', track: 'onchain', orderId, message });
}

// ── ① 의뢰 등록 ─────────────────────────────────────────────

export function ocOrderRequest(ctx: OcContext, event: InboxEvent): HandlerResult {
  const orderId = extractOrderId(event.tags);
  if (!isOrderId(orderId)) return ignored('bad-order-id');
  const r = (reason: string) => reject(ctx, orderId, event, reason);

  const amountSat = Number(tagValue(event, 'amount-sat'));
  const customerXonly = tagValue(event, 'customer-xonly');
  const reserveRaw = tagValue(event, 'reserve-krw');
  const reserveKrw = reserveRaw === undefined ? undefined : Number(reserveRaw);
  const expiration = Number(tagValue(event, 'expiration'));
  if (!Number.isInteger(amountSat) || amountSat <= 0 || !customerXonly || !isXonlyHex(customerXonly)) {
    return ignored('bad-request');
  }
  if (reserveKrw !== undefined && !(Number.isFinite(reserveKrw) && reserveKrw > 0)) return ignored('bad-reserve');
  if (getOc(ctx, orderId) || candidatesOf(ctx, orderId).length > 0) return ignored('duplicate');

  if (!loadSettings(ctx.db).onchain.acceptNewOrders) return r('지금은 온체인 의뢰를 받지 않습니다');

  // 환불 받을 주소 — 없으면 환불이 앱만 쓸 수 있는 주소로 간다. 받지 않는다
  const payload = decrypt(ctx, event);
  if (!isOnchainOrderRequestPayload(payload)) return r('환불 받을 주소가 없습니다. 앱을 새로 고친 뒤 다시 등록해 주세요');
  const refundAddress = payload.refundAddress.trim();
  const addrProblem = addressProblem(refundAddress, ctx.network);
  if (addrProblem) return r(`환불 주소를 쓸 수 없습니다: ${addrProblem}`);

  const now = nowSec(ctx);
  // 만료 상한을 넘으면 보증금 CLTV가 채널 상한을 넘어 인보이스를 못 만든다
  if (!isOrderExpiryAllowed(expiration, now)) return r('유효 기간이 허용 범위(최대 7일)를 벗어났습니다');

  // 최저가를 시세 바로 아래에 걸면 컨펌 대기 중의 공짜 옵션이 된다
  if (reserveKrw !== undefined) {
    const problem = reserveProblem({ reserveKrw, amountSat, btcPriceKrw: ctx.price() ?? undefined });
    if (problem) return r(problem);
  }

  const fees = currentFees(ctx.db, now);
  if (!fees) return r('네트워크 수수료를 조회하지 못했습니다. 잠시 후 다시 시도해 주세요');
  const floor = depositFloorSat(Math.ceil(TYPICAL_SETTLEMENT_VSIZE * fees.halfHour));
  const minTrade = minTradeSat(floor);
  if (amountSat < minTrade) {
    // 이 아래로는 보증금이 거래액의 3%를 넘어 억제가 아니라 허들이 된다
    return r(`지금 수수료 기준 최소 거래액은 ${minTrade.toLocaleString()} sats입니다 (요청: ${amountSat.toLocaleString()} sats)`);
  }
  const cltvBlocks = depositCltvBlocks(expiration, now);
  if (cltvBlocks > CLTV_MAX_BLOCKS) return r('유효 기간이 길어 보증금 인보이스를 만들 수 없습니다');

  const inv = ctx.holds.plan({
    purpose: 'oc-customer-bond', orderId, party: event.pubkey,
    amountSat: depositSat(amountSat, CUSTOMER_DEPOSIT_PERCENT, floor), payBy: expiration, cltvBlocks,
  });
  putCandidate(ctx, {
    paymentHash: inv.payment_hash, orderId, type: 'customer', party: event.pubkey, createdAt: now,
    info: { amountSat, ...(reserveKrw !== undefined ? { reserveKrw } : {}), expiration, customerXonly, refundAddress, cltvBlocks },
  });
  return ok;
}

// ── ② 클레임 ────────────────────────────────────────────────

/** 주소 검증용 임시 기술자 — 어드민 키가 아직 없을 때 모양만 확인한다 */
function dummyDescriptorFor(order: OnchainOrder, sponsorXonly: string): EscrowDescriptor {
  return deriveEscrowAddress({
    keys: { customer: order.customerXonly ?? '11'.repeat(32), sponsor: sponsorXonly, admin: '22'.repeat(32) },
    network: order.network,
  });
}

export function ocClaim(ctx: OcContext, event: InboxEvent): HandlerResult {
  const orderId = extractOrderId(event.tags);
  if (!isOrderId(orderId)) return ignored('bad-order-id');
  const r = (reason: string) => reject(ctx, orderId, event, reason);
  const sponsorXonly = tagValue(event, 'sponsor-xonly');
  if (!sponsorXonly || !isXonlyHex(sponsorXonly)) return ignored('bad-request');

  const order = getOc(ctx, orderId)?.order;
  if (!order || order.state !== 'listed') return r('이 의뢰는 이미 다른 분이 맡았거나 끝났습니다');
  if (event.pubkey === order.customerPubkey) return r('자기 의뢰는 맡을 수 없습니다');
  const now = nowSec(ctx);
  if (order.expiration <= now) return r('의뢰가 만료됐습니다');

  const sponsors = candidatesOf(ctx, orderId).filter(c => c.type === 'sponsor');
  if (sponsors.some(c => c.party === event.pubkey)) return ignored('duplicate');
  if (sponsors.length >= MAX_CLAIM_CANDIDATES) {
    return r('이 의뢰에 보증금 결제를 기다리는 분이 이미 여럿입니다 — 잠시 후 다시 시도해 주세요');
  }

  const payload = decrypt(ctx, event);
  if (!isOnchainClaimPayload(payload)) return r('받을 주소·수수료율을 읽지 못했습니다. 다시 시도해 주세요');
  const payoutAddress = payload.payoutAddress.trim();

  // 받을 주소가 이 네트워크의 것인지, 수수료율이 거래를 멈추지 않는지 **지금** 본다 — 나중에 알면 종결 직전에
  // 막히거나 터무니없는 수수료로 고객 BTC가 묶인다
  const addrProblem = addressProblem(payoutAddress, order.network);
  if (addrProblem) return r(`받을 주소를 쓸 수 없습니다: ${addrProblem}`);
  const fees = currentFees(ctx.db, now);
  if (!fees) return r('네트워크 수수료를 조회하지 못했습니다. 잠시 후 다시 시도해 주세요');

  let releaseFeeSat: number;
  let dustSat: number;
  try {
    const dummy = dummyDescriptorFor(order, sponsorXonly);
    releaseFeeSat = settlementFeeSat('release', dummy, payoutAddress, payload.feerateSatPerVb);
    dustSat = dustThresholdFor(payoutAddress, dummy);
  } catch (e) {
    return r(`받을 주소·키를 쓸 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  const feeProblem = releaseFeerateProblem({
    feerateSatPerVb: payload.feerateSatPerVb, fastestSatPerVb: fees.fastest,
    amountSat: order.amountSat, releaseFeeSat, dustSat,
  });
  if (feeProblem) return r(feeProblem);

  const floor = depositFloorSat(Math.ceil(TYPICAL_SETTLEMENT_VSIZE * fees.halfHour));
  // 보증금은 **남은 의뢰 수명 + 거래 최악 소요**를 덮어야 한다 — 막바지 클레임도
  const cltvBlocks = depositCltvBlocks(order.expiration, now);
  if (cltvBlocks > CLTV_MAX_BLOCKS) return r('의뢰 만료가 너무 멀어 보증금을 받을 수 없습니다');

  const inv = ctx.holds.plan({
    purpose: 'oc-sponsor-bond', orderId, party: event.pubkey,
    amountSat: depositSat(order.amountSat, SPONSOR_DEPOSIT_PERCENT, floor), payBy: order.expiration, cltvBlocks,
  });
  putCandidate(ctx, {
    paymentHash: inv.payment_hash, orderId, type: 'sponsor', party: event.pubkey, createdAt: now,
    info: { sponsorXonly, payoutAddress, feerateSatPerVb: payload.feerateSatPerVb, cltvBlocks },
  });
  return ok;
}

// ── ③ 사전서명 ──────────────────────────────────────────────

function ocPresig(ctx: OcContext, event: InboxEvent, row: OcRow): HandlerResult {
  const { order, meta } = row;
  if (event.pubkey !== order.sponsorPubkey) return ignored('not-sponsor');
  const r = (reason: string) => reject(ctx, order.orderId, event, reason);

  // 마감을 **핸들러가 직접** 본다 — 워처 틱 사이에 들어온 늦은 사전서명으로 환불로 넘어간 거래가 다시 굴러간다
  if (order.state !== 'funded' || order.settlementKind) {
    return r('사전서명을 받을 수 없는 단계입니다 — 마감이 지나 환불로 넘어갔을 수 있습니다');
  }
  if (isPast(presignDeadlineOf(order), requestAt(ctx, event))) return r('사전서명 마감(가격 확정 후 15분)이 지났습니다');

  const expected = settlementParamsFor(order, meta, 'release');
  if (!meta.payoutAddress || !expected) {
    anomaly(ctx, order.orderId, '사전서명을 검증할 재료가 없다 (받을 주소·수수료)');
    return ignored('no-material');
  }
  const payload = decrypt(ctx, event);
  if (!isOnchainPsbtPayload(payload)) return ignored('bad-payload');

  // ⚠️ **우리가 직접 만든 tx**와 대조한다. 상대가 준 값으로 기대치를 만들면 검증이 아니다
  const verdict = verifyPresignature({ psbtBase64: payload.psbt, expected, signerXonly: order.sponsorXonly! });
  if (!verdict.ok) {
    return r(`사전서명이 맞지 않습니다: ${verdict.reason} — 클레임 때 낸 받을 주소·수수료율과 같은지 확인하세요`);
  }

  const at = nowSec(ctx);
  const presigned = updateOc(ctx, order.orderId, {
    state: 'presigned', presignedAt: at, accountDeadline: accountDeadlineFrom(at),
  }, { presigPsbt: payload.psbt });
  notifyOcTransition(ctx, presigned, getOc(ctx, order.orderId)!.version);
  // 고객이 나중에 릴리스에 서명할 수 있게 **지금** 보낸다. 안에 든 건 후원자 서명뿐 — 고객 서명 없이는
  // 아무것도 완성되지 않는다
  sendOcSignRequest(ctx, order.orderId, order.customerPubkey, 'release', payload.psbt);
  return ok;
}

/** 릴리스 PSBT(후원자 사전서명)를 고객에게 다시 보낸다 — 운영자 명령 */
export function resendRelease(ctx: OcContext, row: OcRow): boolean {
  if (!row.meta.presigPsbt) return false;
  sendOcSignRequest(ctx, row.order.orderId, row.order.customerPubkey, 'release', row.meta.presigPsbt);
  return true;
}

// ── ④ 최종 서명 → 장부 → 브로드캐스트 ───────────────────────

const SIGN_PURPOSES: readonly SignPurpose[] = ['release', 'refund', 'dispute-customer', 'dispute-sponsor', 'rescue'];

function ocCosign(ctx: OcContext, event: InboxEvent, row: OcRow): HandlerResult {
  const purpose = tagValue(event, 'purpose') as SignPurpose | undefined;
  if (!purpose || !SIGN_PURPOSES.includes(purpose)) return ignored('bad-purpose');
  if (purpose === 'rescue') return ocRescueCosign(ctx, event, row);
  const { order, meta } = row;

  // **진실은 FSM이다** — 화면만 막으면 수정한 클라이언트가 `remitted`에서 환불 서명을 보내 원화와 BTC를
  // 다 가져간다
  if (!canActOnSignRequest(order.state, purpose, order.settlementKind)) return ignored('not-now');
  const kind: SettlementKind | undefined = purpose === 'release' ? 'release' : order.settlementKind;
  if (!kind || signPurposeFor(kind) !== purpose) return ignored('purpose-mismatch');

  const signerRole = awaitingSignerFor(kind);
  const expectedSender = signerRole === 'sponsor' ? order.sponsorPubkey : order.customerPubkey;
  const signerXonly = signerRole === 'sponsor' ? order.sponsorXonly : order.customerXonly;
  if (event.pubkey !== expectedSender || !signerXonly) return ignored('not-signer');

  const expected = settlementParamsFor(order, meta, kind);
  if (!expected) {
    anomaly(ctx, order.orderId, `이 서명을 붙일 종결 tx를 만들 수 없다 (${kind})`);
    return ignored('no-material');
  }
  const payload = decrypt(ctx, event);
  if (!isOnchainPsbtPayload(payload)) return ignored('bad-payload');

  const verdict = verifyPresignature({ psbtBase64: payload.psbt, expected, signerXonly });
  if (!verdict.ok) return reject(ctx, order.orderId, event, `서명이 맞지 않습니다: ${verdict.reason}`);

  // 우리 tx를 **다시 만들고** 검증한 서명만 옮겨 심는다
  let rawHex: string;
  let txid: string;
  try {
    const tx = buildSettlementTx(expected);
    addTapScriptSig(tx, verdict.leafScript, signerXonly, verdict.sig);
    if (kind === 'release') {
      // 후원자 서명은 `presigned`에서 **우리가 검증해 보관한 것**을 쓴다
      const sponsor = meta.presigPsbt
        ? verifyPresignature({ psbtBase64: meta.presigPsbt, expected, signerXonly: order.sponsorXonly! })
        : null;
      if (!sponsor?.ok) {
        anomaly(ctx, order.orderId, '보관한 사전서명이 릴리스 tx와 맞지 않는다');
        return ignored('no-presig');
      }
      addTapScriptSig(tx, sponsor.leafScript, order.sponsorXonly!, sponsor.sig);
    } else {
      // **어드민은 마지막에 서명한다.** 이 순간 전까지 고객 손에 완성 가능한 tx가 없다
      signSettlement(tx, adminKeyOf(ctx, order.orderId));
    }
    finalizeSettlement(tx, expected.path);
    rawHex = tx.hex;
    txid = tx.id;
  } catch (e) {
    anomaly(ctx, order.orderId, `종결 tx를 완성하지 못했다: ${e instanceof Error ? e.message : String(e)}`);
    return ignored('cannot-finalize');
  }

  enterSettling(ctx, order.orderId, kind, txid, rawHex);
  return ok;
}

/**
 * 종결 tx를 **장부에 먼저** 적고(outbox + `settling`) 뿌리는 건 효과가 한다. 같은 트랜잭션이라 "뿌렸는데
 * 장부에 없다"가 없다 — 프론트 시절 그게 리오그로 오인돼 엉뚱한 쪽이 몰수됐다.
 */
function enterSettling(ctx: OcContext, orderId: string, kind: SettlementKind, txid: string, rawHex: string): void {
  const settling = updateOc(ctx, orderId, {
    state: 'settling', settlementKind: kind, settlementTxid: txid, settlingAt: nowSec(ctx),
  }, { outbox: { txid, rawHex, kind } });
  // 릴리스는 **고객 서명이 온 이 순간** 결정된 것이다(2026-09-25). 보관한 후원자 사전서명과 합쳐 tx가 완성됐고,
  // 에스크로를 다른 길로 뺄 수 있는 건 어드민 서명이 필요한 경로(우리가 안 한다)와 8주 타임락뿐이다 — 되돌릴
  // 수 없다. 보증금이 막을 이탈이 더는 없으니 컨펌을 기다리지 않고 지금 돌려준다(다른 사유는 원래 결정 때 처리)
  if (kind === 'release') applyOutcome(ctx, settling, kind);
  requestBroadcast(ctx, { orderId, txid });
}

export function requestBroadcast(ctx: OcContext, payload: BroadcastPayload): void {
  ctx.effects.enqueue<BroadcastPayload>(OC_BROADCAST_EFFECT, payload, { dedup: `oc.broadcast:${payload.txid}` });
}

// ── ⑤ 원화 송금 주장 · 계좌 공개 · 취소 · 분쟁 ───────────────

/**
 * 후원자가 "원화 보냈다" → `presigned → remitted`. **일방적 주장이다**(O-007) — 여기서 릴리스가 나가지
 * 않는다. 고객이 은행을 확인하고 서명해야만 BTC가 움직인다.
 */
function ocRemit(ctx: OcContext, event: InboxEvent, row: OcRow): HandlerResult {
  const { order } = row;
  if (event.pubkey !== order.sponsorPubkey) return ignored('not-sponsor');
  const r = (reason: string) => reject(ctx, order.orderId, event, reason);
  if (order.state !== 'presigned' || order.settlementKind) {
    return r('송금 완료를 받을 수 없는 단계입니다 — 마감이 지나 환불로 넘어갔을 수 있습니다');
  }
  if (!order.accountSentAt) return r('고객 계좌가 아직 전달되지 않았습니다');
  if (isPast(krwDeadlineOf(order), requestAt(ctx, event))) return r('원화 송금 마감이 지났습니다');

  const remittedAt = nowSec(ctx);
  const remitted = updateOc(ctx, order.orderId, {
    state: 'remitted', remittedAt, cosignDeadline: cosignDeadlineFrom(remittedAt),
  });
  notifyOcTransition(ctx, remitted, getOc(ctx, order.orderId)!.version);
  return ok;
}

/**
 * 고객이 계좌를 공개했다 (O-002·O-003·O-013). 계좌 자체는 후원자에게만 암호화돼 가고, 우리는 **시각과
 * 커밋먼트**만 적는다. 후원자 송금 마감은 **여기서부터** 센다 — 고객 지연이 후원자 창을 깎지 않는다.
 */
function ocAccountInfo(ctx: OcContext, event: InboxEvent, row: OcRow): HandlerResult {
  const { order } = row;
  // 제3자가 가짜 계좌를 후원자에게 보내며 이걸로 시계까지 시작시키면 후원자가 공격자 계좌로 송금한다
  if (event.pubkey !== order.customerPubkey) return ignored('not-customer');
  if (order.state !== 'presigned' || order.accountSentAt || order.settlementKind) return ignored('bad-state');
  if (isPast(accountDeadlineOf(order), requestAt(ctx, event))) {
    return reject(ctx, order.orderId, event, '계좌 공개 마감이 지나 거래가 환불로 넘어갑니다');
  }
  const commitment = tagValue(event, 'commitment');
  const at = nowSec(ctx);
  const updated = updateOc(ctx, order.orderId, { accountSentAt: at, krwDeadline: krwDeadlineFrom(at) },
    commitment ? { accountCommitment: commitment } : undefined);
  notifyOcAccountArrived(ctx, updated);
  return ok;
}

/**
 * 고객이 의뢰를 내린다 → `listed → cancelled`, 보증금 환불. **`listed`에서만** — 후원자 보증금이 잡힌 뒤에는
 * 상대가 이미 돈을 걸었고 마감과 체인이 판정한다(O-001).
 */
function ocCancel(ctx: OcContext, event: InboxEvent): HandlerResult {
  const orderId = extractOrderId(event.tags);
  if (!orderId) return ignored('no-order');
  const row = getOc(ctx, orderId);
  if (!row) {
    // 보증금을 내기 전에 접은 의뢰
    const mine = candidatesOf(ctx, orderId).filter(c => c.type === 'customer' && c.party === event.pubkey);
    for (const c of mine) {
      ctx.holds.dispose(c.paymentHash, 'cancel');
      deleteCandidate(ctx, c.paymentHash);
    }
    return mine.length > 0 ? ok : ignored('unknown-order');
  }
  if (event.pubkey !== row.order.customerPubkey) return ignored('not-customer');
  if (row.order.state !== 'listed') return reject(ctx, orderId, event, '후원자가 이미 붙어 의뢰를 내릴 수 없습니다');

  const cancelled = updateOc(ctx, orderId, { state: 'cancelled' });
  applyOutcome(ctx, cancelled, 'cancel:customer');
  notifyOcTransition(ctx, cancelled, getOc(ctx, orderId)!.version);
  // 결제 안 된 후원자 인보이스를 치운다 — 취소 뒤에 결제해 "냈는데 늦었다"를 겪지 않게
  dropSponsorCandidates(ctx, orderId);
  return ok;
}

function ocDispute(ctx: OcContext, event: InboxEvent, row: OcRow): HandlerResult {
  const { order } = row;
  if (event.pubkey !== order.customerPubkey && event.pubkey !== order.sponsorPubkey) return ignored('not-a-party');
  const r = (reason: string) => reject(ctx, order.orderId, event, reason);

  if (order.state === 'remitted') {
    const disputed = updateOc(ctx, order.orderId, { state: 'disputed', disputedAt: nowSec(ctx) });
    notifyOcTransition(ctx, disputed, getOc(ctx, order.orderId)!.version);
    return ok;
  }

  // ⚠️ **계좌 이의는 상태가 아니다**. 상태로 받으면 원화 마감 시계가 멈추고 무한 옵션이 열린다
  // 시각만 박아 두고, 마감이 차면 `refund:account-disputed`로 보증금을 붙잡는다
  if (order.state === 'presigned' && tagValue(event, 'stage') === 'account-unusable') {
    const allowed = event.pubkey === order.sponsorPubkey
      && order.accountSentAt !== undefined
      && !order.accountDisputedAt
      && !order.settlementKind
      && !isPast(krwDeadlineOf(order), requestAt(ctx, event));
    if (!allowed) return r('계좌 이의는 계좌를 받은 뒤 송금 마감 전에만 낼 수 있습니다');
    updateOc(ctx, order.orderId, { accountDisputedAt: nowSec(ctx) });
    return ok;
  }
  return r('이 단계에서는 분쟁을 열 수 없습니다');
}

// ── ⑥ 종결 결정 (워처·운영자 판정) ──────────────────────────

export type DecideError = 'bad-state' | 'no-fees' | 'no-material' | 'cannot-build';

/**
 * 종결을 **결정**한다 — 사유와 수수료를 오더에 박고, 보증금을 처리하고, 서명을 요청한다.
 *
 * - 환불(`refund:*`) → `refunding`. `fold`면 `bonded`에서 바로 간다(가격을 고정하지 않고 접는다)
 * - 분쟁 판정(`sponsor_win`·`customer_win`) → 상태는 `disputed` 그대로, 판정이 박힌다
 *
 * **보증금은 여기서 처리한다**. 결정은 **되돌리지 않는다.**
 */
export function decideSettlement(
  ctx: OcContext,
  orderId: string,
  kind: SettlementKind,
  fold?: { outpoint: Outpoint; confirmations: number },
): { ok: true; order: OnchainOrder } | { ok: false; error: DecideError } {
  const row = getOc(ctx, orderId);
  if (!row) return { ok: false, error: 'bad-state' };
  const { order, meta } = row;

  const ruling = kind === 'sponsor_win' || kind === 'customer_win';
  if (ruling) {
    if (order.state !== 'disputed' || order.settlementKind) return { ok: false, error: 'bad-state' };
  } else if (isRefundKind(kind)) {
    const allowed = fold ? order.state === 'bonded' : order.state === 'funded' || order.state === 'presigned';
    if (!allowed || order.settlementKind) return { ok: false, error: 'bad-state' };
  } else {
    return { ok: false, error: 'bad-state' }; // 릴리스는 결정하는 게 아니다 — 고객이 서명해야만 나간다(O-007)
  }

  const fees = currentFees(ctx.db, nowSec(ctx));
  if (!fees) return { ok: false, error: 'no-fees' };

  const draft: OnchainOrder = fold
    ? { ...order, fundingOutpoint: formatOutpoint(fold.outpoint.txid, fold.outpoint.vout) }
    : order;
  const shape = settlementParamsFor(draft, meta, kind, 0);
  if (!shape) {
    anomaly(ctx, orderId, `종결 재료가 없다 (${kind})`);
    return { ok: false, error: 'no-material' };
  }
  let feeSat: number;
  try {
    // ⚠️ **수수료를 새로 추정한다.** `releaseFeeSat`은 T0에 고정된 값이라 분쟁이 몇 주 뒤에 끝나면 낡는다.
    // 다만 후원자승은 후원자가 받는 출력에서 수수료가 나가고 **후원자가 정한 수수료율**이 있다 — 그보다 낮추지
    // 않는다(시세가 더 높으면 시세). 5 sat/vB로 냈는데 판정 경로만 1 sat/vB로 나갔다(2026-09-25 signet 드릴)
    const feerate = kind === 'sponsor_win' ? Math.max(meta.feerateSatPerVb ?? 0, fees.halfHour) : fees.halfHour;
    feeSat = settlementFeeSat(shape.path, shape.descriptor, shape.destination, feerate);
    buildSettlementTx({ ...shape, feeSat }); // dust 등 — 만들 수 있는 tx인지 지금 확인한다
  } catch (e) {
    anomaly(ctx, orderId, `종결 tx를 만들 수 없다 (${kind}): ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, error: 'cannot-build' };
  }

  const patch: OcPatch = {
    settlementKind: kind,
    settlementFeeSat: feeSat,
    decidedAt: nowSec(ctx),
    ...(ruling ? {} : { state: 'refunding' as const }),
    ...(fold ? { fundingOutpoint: draft.fundingOutpoint, fundingConfs: fold.confirmations } : {}),
  };
  const updated = updateOc(ctx, orderId, patch);
  applyOutcome(ctx, updated, kind);
  // 판정은 상태가 안 바뀌어 전이 알림이 없다 — 이긴 쪽이 서명해야 집행되므로 따로 알린다
  if (ruling) notifyOcRuling(ctx, updated);
  else notifyOcTransition(ctx, updated, getOc(ctx, orderId)!.version);
  requestSettlementSignature(ctx, orderId);
  ctx.log.info('온체인 종결 결정', { orderId, kind, feeSat });
  return { ok: true, order: updated };
}

/**
 * 결정된 종결의 서명을 요청한다 — **서명 없는** PSBT를 보낸다. 받는 쪽은 이걸 믿지 않고 자기 기록으로 같은
 * tx를 다시 만들어 서명한다. 여기 담긴 건 사실상 "수수료가 얼마인가" 하나다.
 */
export function requestSettlementSignature(ctx: OcContext, orderId: string): boolean {
  const row = getOc(ctx, orderId);
  const kind = row?.order.settlementKind;
  if (!row || !kind || kind === 'release') return false;
  const params = settlementParamsFor(row.order, row.meta, kind);
  const recipient = awaitingSignerFor(kind) === 'sponsor' ? row.order.sponsorPubkey : row.order.customerPubkey;
  if (!params || !recipient) {
    anomaly(ctx, orderId, '서명 요청을 만들 재료가 없다');
    return false;
  }
  sendOcSignRequest(ctx, orderId, recipient, signPurposeFor(kind), toPsbtBase64(buildSettlementTx(params)));
  updateOcMeta(ctx, orderId, { lastSignRequestAt: nowSec(ctx) });
  return true;
}

/**
 * 계좌 이의를 판정한다 — 잠정 사유(`refund:account-disputed`)를 확정한다. 환불 tx는 사유와 무관하게
 * 같은 모양이라 고객 서명은 그대로 유효하다. 입증책임 — 몰수를 면하려는 쪽(후원자)이 증명한다.
 */
export function resolveAccountDispute(
  ctx: OcContext, orderId: string, verdict: 'account-bad' | 'sponsor-fault',
): 'not-disputed' | 'bad-state' | null {
  const row = getOc(ctx, orderId);
  if (!row || row.order.settlementKind !== 'refund:account-disputed') return 'not-disputed';
  if (!['refunding', 'settling', 'refunded'].includes(row.order.state)) return 'bad-state';
  const kind: SettlementKind = verdict === 'account-bad' ? 'refund:customer-late' : 'refund:sponsor-timeout';
  const updated = updateOc(ctx, orderId, { settlementKind: kind });
  applyOutcome(ctx, updated, kind);
  return null;
}

// ── ⑦ 구조 (약정 밖의 자금 → 고객) ──────────────────────────

function rescueKeyOf(o: { txid: string; vout: number }): string {
  return `${o.txid}:${o.vout}`;
}

/** 진행 중인 거래의 에스크로는 구조 대상이 아니다 — 그건 종결 tx가 쓴다(후원자가 송금한 뒤 돌리면 탈취다) */
function isPinnedOfLiveTrade(order: OnchainOrder, utxo: { txid: string; vout: number }): boolean {
  const pinned = parseOutpoint(order.fundingOutpoint);
  if (!pinned || pinned.txid !== utxo.txid || pinned.vout !== utxo.vout) return false;
  return !isOnchainTerminal(order.state);
}

/**
 * 약정 밖의 자금 하나를 고객에게 돌려주는 요청을 보낸다 — 금액이 틀린 펀딩, 이중 송금, 취소 뒤
 * 늦게 컨펌된 펀딩, 확정 뒤 추가 입금. `{A,C}` 리프로 **고객이 낸 환불 주소**에 보낸다.
 * @returns 거절 사유. 보냈으면 `null`
 */
export function requestRescue(ctx: OcContext, orderId: string, utxo: OcUtxo): string | null {
  const row = getOc(ctx, orderId);
  if (!row) return 'unknown-order';
  const { order, meta } = row;
  if (isPinnedOfLiveTrade(order, utxo)) return 'live-escrow';
  const descriptor = escrowDescriptorFor(order);
  const destination = refundDestinationFor(order, meta);
  if (!descriptor || !destination) return 'no-material';
  const fees = currentFees(ctx.db, nowSec(ctx));
  if (!fees) return 'no-fees';

  let psbt: string;
  let feeSat: number;
  try {
    feeSat = settlementFeeSat('refund', descriptor, destination, fees.halfHour);
    psbt = toPsbtBase64(buildSettlementTx({
      descriptor, input: { outpoint: utxo, valueSat: utxo.valueSat }, path: 'refund', destination, feeSat,
    }));
  } catch {
    return 'cannot-build';
  }
  const rescues = { ...meta.rescues, [rescueKeyOf(utxo)]: { ...utxo, feeSat, destination, createdAt: nowSec(ctx) } };
  updateOcMeta(ctx, orderId, { rescues });
  sendOcSignRequest(ctx, orderId, order.customerPubkey, 'rescue', psbt);
  return null;
}

function ocRescueCosign(ctx: OcContext, event: InboxEvent, row: OcRow): HandlerResult {
  const { order, meta } = row;
  if (event.pubkey !== order.customerPubkey || !order.customerXonly) return ignored('not-customer');
  const payload = decrypt(ctx, event);
  if (!isOnchainPsbtPayload(payload)) return ignored('bad-payload');

  // 어느 UTXO에 대한 서명인지는 PSBT 입력에서 읽고, **나머지는 우리 기록**으로 만든다
  let outpoint: Outpoint;
  try {
    const input = fromPsbtBase64(payload.psbt).getInput(0);
    if (!input?.txid || input.index === undefined) return ignored('bad-psbt');
    outpoint = { txid: bytesToHex(input.txid), vout: input.index };
  } catch {
    return ignored('bad-psbt');
  }
  const key = rescueKeyOf(outpoint);
  const rescue = meta.rescues?.[key];
  if (!rescue) return ignored('unrequested-rescue');
  if (rescue.broadcastTxid || rescue.rawHex) return ignored('already');
  if (isPinnedOfLiveTrade(order, outpoint)) {
    anomaly(ctx, order.orderId, '진행 중인 거래의 에스크로를 구조하려 했다');
    return ignored('live-escrow');
  }
  const descriptor = escrowDescriptorFor(order);
  if (!descriptor) return ignored('no-material');
  const expected = {
    descriptor, input: { outpoint, valueSat: rescue.valueSat }, path: 'refund' as const,
    destination: rescue.destination, feeSat: rescue.feeSat,
  };
  const verdict = verifyPresignature({ psbtBase64: payload.psbt, expected, signerXonly: order.customerXonly });
  if (!verdict.ok) return reject(ctx, order.orderId, event, `구조 서명이 맞지 않습니다: ${verdict.reason}`);

  try {
    const tx = buildSettlementTx(expected);
    addTapScriptSig(tx, verdict.leafScript, order.customerXonly, verdict.sig);
    signSettlement(tx, adminKeyOf(ctx, order.orderId));
    finalizeSettlement(tx, 'refund');
    updateOcMeta(ctx, order.orderId, { rescues: { ...meta.rescues, [key]: { ...rescue, rawHex: tx.hex } } });
    requestBroadcast(ctx, { orderId: order.orderId, txid: tx.id, rescueKey: key });
  } catch (e) {
    anomaly(ctx, order.orderId, `구조 tx를 완성하지 못했다: ${e instanceof Error ? e.message : String(e)}`);
    return ignored('cannot-finalize');
  }
  return ok;
}

// ── 라우팅 ───────────────────────────────────────────────────

type RowHandler = (ctx: OcContext, event: InboxEvent, row: OcRow) => HandlerResult;

function withRow(ctx: OcContext, handler: RowHandler) {
  return (event: InboxEvent): HandlerResult => {
    const orderId = extractOrderId(event.tags);
    if (!orderId) return ignored('no-order');
    const row = getOc(ctx, orderId);
    if (!row) return ignored('unknown-order');
    return handler(ctx, event, row);
  };
}

/** action → 핸들러. 송금 완료·취소·계좌는 라이트닝과 같은 action이고 `t` 태그로 갈린다 */
export function createOcHandlers(ctx: OcContext): ReadonlyMap<string, (event: InboxEvent) => HandlerResult> {
  return new Map([
    [REQUEST_ACTIONS.ONCHAIN_ORDER_REQUEST, (event: InboxEvent) => ocOrderRequest(ctx, event)],
    [REQUEST_ACTIONS.ONCHAIN_CLAIM, (event: InboxEvent) => ocClaim(ctx, event)],
    [REQUEST_ACTIONS.ONCHAIN_PRESIG, withRow(ctx, ocPresig)],
    [REQUEST_ACTIONS.ONCHAIN_COSIGN, withRow(ctx, ocCosign)],
    [REQUEST_ACTIONS.ONCHAIN_DISPUTE, withRow(ctx, ocDispute)],
    [REQUEST_ACTIONS.REMIT_REQUEST, withRow(ctx, ocRemit)],
    [REQUEST_ACTIONS.ACCOUNT_INFO, withRow(ctx, ocAccountInfo)],
    [REQUEST_ACTIONS.CANCEL_REQUEST, (event: InboxEvent) => ocCancel(ctx, event)],
  ]);
}

