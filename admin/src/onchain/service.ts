/**
 * 온체인 요청 핸들러 (PLAN-ONCHAIN-TRACK §5.2 · §9)
 *
 * 사람이 미는 쪽이다 — 의뢰 등록, 클레임, 사전서명, 최종 서명, 분쟁, 구조.
 * 체인이 미는 쪽은 `watcher.ts`가 맡는다.
 *
 * ── §9 자동화표를 그대로 따른다
 *
 * 판단이 필요 없는 건 전부 자동이다. **사람이 손대는 건 분쟁 판정·계좌 이의 판정·
 * 구조 셋**이다. 그리고 자동화하면 안 되는 것도 하나 있다 — **릴리스 cosign**(O-007).
 *
 * ── 리뷰 #8에서 바뀐 규칙 넷
 *
 * 1. **어드민은 언제나 마지막에 서명한다.** 전에는 환불 PSBT에 어드민 서명을 먼저
 *    얹어 고객에게 보냈다. 서명은 만료되지 않으므로(§7.6) 고객은 **완성 가능한 환불**을
 *    쥔 채로 거래를 계속할 수 있었다 — 원화를 받은 뒤 그걸로 빠져나가면 원화와 BTC를
 *    다 가진다. 이제 고객에게는 **서명 없는** PSBT가 가고, 고객 서명을 검증한 뒤
 *    어드민이 서명해 **직접** 브로드캐스트한다.
 * 2. **결정은 상태다.** 환불이 결정되면 `refunding`으로 간다. 그 뒤로 늦은 사전서명·
 *    늦은 계좌·늦은 송금 주장은 전부 거절된다. 핸들러도 마감을 **직접** 본다 —
 *    워처 틱(30초) 사이에 들어온 것도 막는다.
 * 3. **누가 보냈는지 본다.** 계좌 공개 알림을 아무나 보낼 수 있었다.
 * 4. **발행이 먼저, 브로드캐스트가 나중.** outbox에 raw tx를 남기고 `settling`을 발행한
 *    뒤에만 뿌린다. 발행이 실패하면 체인에 아무것도 안 뜬다 — 워처가 나중에 마무리한다.
 */
import type { LightningAdapter } from '../lightning';
import { APP_PUBKEY } from '@sajwo-tracker/shared';
import type {
  OnchainClaimMsg, OnchainCosignMsg, OnchainDisputeMsg,
  OnchainOrderRequestMsg, OnchainPresigMsg,
} from '@sajwo-tracker/shared/onchain';
import {
  FUNDING_WINDOW_SEC, TYPICAL_SETTLEMENT_VSIZE,
  accountDeadlineOf, addTapScriptSig, addressProblem, awaitingSignerFor, buildSettlementTx, bytesToHex,
  canActOnSignRequest, canOnchainTransition, deriveEscrowAddress, deriveSingleKeyAddress,
  dustThresholdFor, finalizeSettlement, formatOutpoint, fromPsbtBase64, isOnchainClaimPayload,
  isOnchainOrderRequestPayload, isOnchainPsbtPayload, isOnchainTerminal, isOrderExpiryAllowed,
  isPast, isRefundKind, krwDeadlineFrom, krwDeadlineOf, onchainMessageExpiration, parseOutpoint,
  presignDeadlineOf, releaseFeerateProblem, reserveProblem, settlementFeeSat,
  settlementPathForKind, signPurposeFor, signSettlement, toPsbtBase64, verifyPresignature,
  type BtcNetworkName, type BuildSettlementParams, type EscrowDescriptor, type FeeEstimates,
  type OnchainOrder, type Outpoint, type SettlementKind,
} from '@sajwo-tracker/shared/onchain';
import { getSigner } from '../nostr/nip46';
import type { ChainAdapter } from '@sajwo-tracker/shared/onchain';
import {
  CUSTOMER_DEPOSIT_PERCENT, SPONSOR_DEPOSIT_PERCENT,
  depositCltvBlocks, depositFloorSat, depositSat, minTradeSat,
} from './deposit';
import { createOrderKeyWithBackup, getOrderKey } from './key-store';
import {
  applyOnchainTransition, getOnchainOrder, getSnapshot, upsertOnchainOrder,
  type OnchainPatch, type TransitionGuard,
} from './order-store';
import {
  deleteOnchainDeposit, depositKey, getOnchainDeposits, getOnchainDepositsFor,
  putOnchainDeposit, type OnchainPendingDeposit,
} from './pending-deposit-store';
import { markSignatureRequested } from './sign-request-log';
import { getRescue, markRescueBroadcast, putRescue } from './rescue-store';
import { getEscrowMeta, mergeEscrowMeta } from './escrow-meta-store';
import {
  publishOnchainDepositRequired, publishOnchainDepositStatus, publishOnchainOrder,
  publishOnchainRejected, publishOnchainSignRequest,
} from './publish';
import { notifyOnchainAccountArrived, notifyOnchainRuling, notifyOnchainTransition } from './notify';
import { handleOnchainOutcome } from './deposit-lifecycle';

// ─── 설정 ────────────────────────────────────────────────────

let lnAdapter: LightningAdapter | null = null;
let chain: ChainAdapter | null = null;
let network: BtcNetworkName = 'mainnet';
/** **신선한** 시세 (KRW/BTC). reserve 경계를 볼 때 쓴다 */
let btcPriceKrw: () => number | undefined = () => undefined;

export function configureOnchainService(cfg: {
  lnAdapter?: LightningAdapter | null;
  chain?: ChainAdapter | null;
  network?: BtcNetworkName;
  btcPriceKrw?: () => number | undefined;
}): void {
  if (cfg.lnAdapter !== undefined) lnAdapter = cfg.lnAdapter;
  if (cfg.chain !== undefined) chain = cfg.chain;
  if (cfg.network !== undefined) network = cfg.network;
  if (cfg.btcPriceKrw !== undefined) btcPriceKrw = cfg.btcPriceKrw;
}

export function onchainNetwork(): BtcNetworkName {
  return network;
}

const now = () => Math.floor(Date.now() / 1000);

/** 보증금 인보이스가 받아야 할 CLTV 상한. 런타임에 채널에서 읽는 게 이상적이다(§2.2) */
const CLTV_CEILING_BLOCKS = 2016;

/** 블록 하나를 몇 초로 보나 — 보증금 만료 **추정**에만 쓴다 */
const BLOCK_SEC = 600;

// ─── 공통 ────────────────────────────────────────────────────

/**
 * 상태 전이 + 발행. 발행이 실패하면 **상태도 되돌린다** — 갈리면 양쪽이 다른 걸 본다.
 *
 * `guard.ifUnchangedSince`를 주면 그 사이 오더가 바뀌었을 때 **쓰지 않는다**(리뷰 #8).
 */
export async function commitOnchainOrder(
  orderId: string,
  patch: OnchainPatch,
  guard: TransitionGuard = {},
): Promise<OnchainOrder | null> {
  const before = getOnchainOrder(orderId);
  const result = applyOnchainTransition(orderId, patch, guard);
  if (!result.success) {
    console.warn('[Onchain] 전이 거부', orderId, result.error);
    return null;
  }
  try {
    await publishOnchainOrder(result.order);
    // 상태가 실제로 바뀐 경우에만 알린다 — 필드만 고친 발행에 알림이 붙으면 소음이 된다.
    if (!before || before.state !== result.order.state) {
      notifyOnchainTransition(result.order);
    }
    return result.order;
  } catch (e) {
    console.error('[Onchain] 발행 실패 — 로컬 상태를 되돌린다', orderId, e);
    // 그 사이 누가 이 위에 또 썼으면 되돌리지 않는다 — 남의 쓰기를 지운다.
    const current = getOnchainOrder(orderId);
    if (before && current?.updatedAt === result.order.updatedAt) {
      upsertOnchainOrder({ ...before, updatedAt: result.order.updatedAt + 1 });
    }
    return null;
  }
}

/** 이 주문의 에스크로 기술자. 세 키가 다 있어야 만들어진다 */
export function escrowDescriptorFor(order: OnchainOrder): EscrowDescriptor | null {
  if (!order.customerXonly || !order.sponsorXonly || !order.adminXonly) return null;
  try {
    return deriveEscrowAddress({
      keys: {
        customer: order.customerXonly,
        sponsor: order.sponsorXonly,
        admin: order.adminXonly,
      },
      network: order.network,
      timelockBlocks: order.timelockBlocks,
    });
  } catch (e) {
    console.error('[Onchain] 에스크로 파생 실패', order.orderId, e);
    return null;
  }
}

/**
 * 릴리스 수수료 — **후원자가 낸 주소·feerate로** 계산한다 (§6.1b).
 * 부담자가 후원자이므로 결정권도 후원자에게 있다.
 */
export function onchainReleaseFeeSat(order: OnchainOrder): number | undefined {
  const meta = getEscrowMeta(order.orderId);
  const descriptor = escrowDescriptorFor(order);
  if (!meta?.payoutAddress || !meta.feerateSatPerVb || !descriptor) return undefined;
  try {
    return settlementFeeSat('release', descriptor, meta.payoutAddress, meta.feerateSatPerVb);
  } catch {
    return undefined;
  }
}

/**
 * 환불·고객승·구조가 가는 주소.
 *
 * 고객이 의뢰 때 낸 **자기 지갑 주소**다(리뷰 #8). 없으면(그 전에 만든 주문) 주문별
 * 키로 만든 단일키 주소로 간다 — 그 경우 고객 앱의 "환불금 보내기"로 꺼낸다.
 */
export function refundDestinationFor(order: OnchainOrder): string | undefined {
  const meta = getEscrowMeta(order.orderId);
  if (meta?.refundAddress) return meta.refundAddress;
  return order.customerXonly ? deriveSingleKeyAddress(order.customerXonly, order.network) : undefined;
}

/**
 * 이 사유로 정해진 종결 tx의 재료 — **우리 기록으로만** 만든다.
 *
 * 사유·수수료·받는 주소가 오더(+백업되는 메타)에 있으므로 어느 기기에서든 같은 tx가
 * 나온다. 상대가 보낸 PSBT는 **서명 바이트를 꺼내는 데만** 쓴다.
 */
export function settlementParamsFor(
  order: OnchainOrder,
  kind: SettlementKind | undefined = order.settlementKind,
  feeSat: number | undefined = order.settlementFeeSat,
): BuildSettlementParams | null {
  const descriptor = escrowDescriptorFor(order);
  const outpoint = parseOutpoint(order.fundingOutpoint);
  if (!descriptor || !outpoint || !kind) return null;

  const path = settlementPathForKind(kind);
  const meta = getEscrowMeta(order.orderId);
  const destination = kind === 'release' || kind === 'sponsor_win'
    ? meta?.payoutAddress
    : refundDestinationFor(order);
  const fee = kind === 'release' ? order.releaseFeeSat : feeSat;
  if (!destination || fee === undefined) return null;

  return { descriptor, input: { outpoint, valueSat: order.amountSat }, path, destination, feeSat: fee };
}

async function decryptFrom(senderPubkey: string, ciphertext: string): Promise<unknown> {
  const signer = getSigner();
  if (!signer) throw new Error('signer 없음');
  return JSON.parse(await signer.nip44Decrypt(senderPubkey, ciphertext)) as unknown;
}

function contentOf(req: { raw: object }): string {
  return (req.raw as { content?: string }).content ?? '';
}

/**
 * 거절을 **유저에게 도달시킨다.** 콘솔 로그로 끝내면 "보냈는데 아무 일도 안 일어난다"가
 * 되고, 유저 쪽에는 흔적이 하나도 없다(2026-09-21 — 의뢰가 그렇게 사라졌다).
 */
async function rejectTo(orderId: string, pubkey: string, reason: string): Promise<void> {
  console.warn('[Onchain] 거절:', orderId, pubkey.slice(0, 8), reason);
  try {
    await publishOnchainRejected(orderId, pubkey, reason, onchainMessageExpiration(now()));
  } catch (e) {
    console.error('[Onchain] 거절 통지 실패', orderId, e);
  }
}

async function currentFees(): Promise<FeeEstimates | null> {
  if (!chain) return null;
  const fees = await chain.getFeeEstimates();
  if (!fees.known) {
    console.warn('[Onchain] 수수료 추정 실패:', fees.reason);
    return null;
  }
  return fees.value;
}

// ─── ① 의뢰 등록 ─────────────────────────────────────────────

export async function handleOnchainOrderRequest(req: OnchainOrderRequestMsg): Promise<void> {
  const reject = (reason: string) => rejectTo(req.orderId, req.pubkey, reason);

  if (!lnAdapter) return reject('운영자 라이트닝 노드가 연결돼 있지 않습니다');
  if (getOnchainOrder(req.orderId)) return;                      // 이미 오더가 있다
  if (getOnchainDepositsFor(req.orderId).length > 0) return;      // 이미 인보이스를 냈다

  // 환불 받을 주소 — 없으면 환불이 앱만 쓸 수 있는 주소로 간다(리뷰 #8). 받지 않는다.
  let payload: unknown;
  try {
    payload = await decryptFrom(req.pubkey, contentOf(req));
  } catch {
    return reject('환불 받을 주소가 없습니다. 앱을 새로 고친 뒤 다시 등록해 주세요');
  }
  if (!isOnchainOrderRequestPayload(payload)) {
    return reject('환불 받을 주소가 없습니다. 앱을 새로 고친 뒤 다시 등록해 주세요');
  }
  const refundAddress = payload.refundAddress.trim();
  const addrProblem = addressProblem(refundAddress, network);
  if (addrProblem) return reject(`환불 주소를 쓸 수 없습니다: ${addrProblem}`);

  // 만료 상한을 넘으면 보증금 CLTV가 채널 상한을 넘어 **인보이스를 못 만든다**(§2.2).
  if (!isOrderExpiryAllowed(req.expiration, now())) {
    return reject('유효 기간이 허용 범위(최대 7일)를 벗어났습니다');
  }

  // 최저가를 시세 바로 아래에 걸면 컨펌 대기 중의 공짜 옵션이 된다(리뷰 #8).
  if (req.reserveKrw !== undefined) {
    const problem = reserveProblem({
      reserveKrw: req.reserveKrw, amountSat: req.amountSat, btcPriceKrw: btcPriceKrw(),
    });
    if (problem) return reject(problem);
  }

  const fees = await currentFees();
  if (!fees) return reject('네트워크 수수료를 조회하지 못했습니다. 잠시 후 다시 시도해 주세요');
  const settlementFee = Math.ceil(TYPICAL_SETTLEMENT_VSIZE * fees.halfHour);

  const floor = depositFloorSat(settlementFee);
  const minTrade = minTradeSat(floor);
  if (req.amountSat < minTrade) {
    // 이 아래로는 보증금이 거래액의 3%를 넘어 억제가 아니라 허들이 된다(§12 Q8).
    return reject(
      `지금 수수료 기준 최소 거래액은 ${minTrade.toLocaleString()} sats입니다 `
      + `(요청: ${req.amountSat.toLocaleString()} sats)`,
    );
  }

  const cltv = depositCltvBlocks(req.expiration, now());
  if (cltv > CLTV_CEILING_BLOCKS) {
    return reject('유효 기간이 길어 보증금 인보이스를 만들 수 없습니다');
  }

  const bondSat = depositSat(req.amountSat, CUSTOMER_DEPOSIT_PERCENT, floor);
  const escrowKey = `onchain:${req.orderId}`;
  const invoice = await lnAdapter.createHoldInvoice(
    escrowKey, bondSat, req.expiration - now(), cltv,
  );
  mergeEscrowMeta(req.orderId, { customerDepositKey: escrowKey });

  putOnchainDeposit({
    orderId: req.orderId,
    type: 'customer',
    customerPubkey: req.pubkey,
    depositPaymentHash: invoice.paymentHash,
    depositBolt11: invoice.bolt11,
    amountSat: bondSat,
    createdAt: now(),
    tradeAmountSat: req.amountSat,
    reserveKrw: req.reserveKrw,
    expiration: req.expiration,
    customerXonly: req.customerXonly,
    refundAddress,
    cltvBlocks: cltv,
  });

  // 인보이스 자체가 의뢰 만료에 끝나므로 이 통지는 의뢰 만료까지면 된다.
  await publishOnchainDepositRequired(req.orderId, req.pubkey, invoice.bolt11, req.expiration);
  console.log('[Onchain] 고객 보증금 요구', req.orderId, bondSat, 'sat');
}

// ─── ② 클레임 ────────────────────────────────────────────────

/**
 * 한 의뢰에 동시에 띄워 둘 수 있는 보증금 인보이스 수.
 *
 * 클레임은 상태를 안 바꾸고 인보이스만 내주므로(§4.1b) **아무나 몇 번이든**
 * 부를 수 있다. 중복 방지는 `orderId:sponsorPubkey`로 하는데 nostr 키는 공짜라
 * 시빌마다 자리가 갈린다 — 결제할 생각 없이 무한히 발행시킬 수 있다.
 *
 * 돈이 걸린 문제는 아니다(미결제 홀드 인보이스는 아무것도 묶지 않는다). 어드민
 * 노드의 인보이스와 릴레이 발행을 태우는 **위생 문제**라 상한 하나로 끝낸다.
 */
const MAX_CLAIM_CANDIDATES = 5;

export async function handleOnchainClaim(req: OnchainClaimMsg): Promise<void> {
  if (!lnAdapter) return;
  const reject = (reason: string) => rejectTo(req.orderId, req.pubkey, reason);

  const order = getOnchainOrder(req.orderId);
  if (!order || order.state !== 'listed') {
    return reject('이 의뢰는 이미 다른 분이 맡았거나 끝났습니다');
  }
  if (req.pubkey === order.customerPubkey) {
    return reject('자기 의뢰는 맡을 수 없습니다');
  }

  const candidates = getOnchainDepositsFor(req.orderId).filter(d => d.type === 'sponsor');
  if (candidates.some(d => d.sponsorPubkey === req.pubkey)) return; // 이미 발행했다
  if (candidates.length >= MAX_CLAIM_CANDIDATES) {
    return reject('이 의뢰에 보증금 결제를 기다리는 분이 이미 여럿입니다 — 잠시 후 다시 시도해 주세요');
  }

  let payload: unknown;
  try {
    payload = await decryptFrom(req.pubkey, contentOf(req));
  } catch {
    return reject('받을 주소·수수료율을 읽지 못했습니다. 다시 시도해 주세요');
  }
  if (!isOnchainClaimPayload(payload)) {
    return reject('받을 주소·수수료율을 읽지 못했습니다. 다시 시도해 주세요');
  }

  // 받을 주소가 이 네트워크의 것인지, 수수료율이 거래를 멈추지 않는지 **지금** 본다.
  // 나중에 알면 종결 직전에 막히거나, 터무니없는 수수료로 고객 BTC가 묶인다(리뷰 #8).
  const addrProblem = addressProblem(payload.payoutAddress, order.network);
  if (addrProblem) return reject(`받을 주소를 쓸 수 없습니다: ${addrProblem}`);

  const fees = await currentFees();
  if (!fees) return reject('네트워크 수수료를 조회하지 못했습니다. 잠시 후 다시 시도해 주세요');

  let releaseFeeSat: number;
  let dustSat: number;
  try {
    const dummy = dummyDescriptorFor(order, req.sponsorXonly);
    releaseFeeSat = settlementFeeSat('release', dummy, payload.payoutAddress, payload.feerateSatPerVb);
    dustSat = dustThresholdFor(payload.payoutAddress, dummy);
  } catch (e) {
    return reject(`받을 주소·키를 쓸 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  const feeProblem = releaseFeerateProblem({
    feerateSatPerVb: payload.feerateSatPerVb,
    fastestSatPerVb: fees.fastest,
    amountSat: order.amountSat,
    releaseFeeSat,
    dustSat,
  });
  if (feeProblem) return reject(feeProblem);

  const floor = depositFloorSat(Math.ceil(TYPICAL_SETTLEMENT_VSIZE * fees.halfHour));
  const bondSat = depositSat(order.amountSat, SPONSOR_DEPOSIT_PERCENT, floor);
  const cltv = depositCltvBlocks(order.expiration, now());
  if (cltv > CLTV_CEILING_BLOCKS) return reject('의뢰 만료가 너무 멀어 보증금을 받을 수 없습니다');

  const escrowKey = `onchain:${req.orderId}:${req.pubkey}`;
  const invoice = await lnAdapter.createHoldInvoice(
    escrowKey, bondSat, order.expiration - now(), cltv,
  );

  putOnchainDeposit({
    orderId: req.orderId,
    type: 'sponsor',
    sponsorPubkey: req.pubkey,
    customerPubkey: order.customerPubkey,
    depositPaymentHash: invoice.paymentHash,
    depositBolt11: invoice.bolt11,
    amountSat: bondSat,
    createdAt: now(),
    sponsorXonly: req.sponsorXonly,
    payoutAddress: payload.payoutAddress.trim(),
    feerateSatPerVb: payload.feerateSatPerVb,
    escrowKey,
    cltvBlocks: cltv,
  });

  await publishOnchainDepositRequired(req.orderId, req.pubkey, invoice.bolt11, order.expiration);
  console.log('[Onchain] 후원자 보증금 요구', req.orderId, req.pubkey.slice(0, 8), bondSat, 'sat');
}

/** 주소 검증용 임시 기술자 — 어드민 키가 아직 없을 때 모양만 확인한다 */
function dummyDescriptorFor(order: OnchainOrder, sponsorXonly: string): EscrowDescriptor {
  return deriveEscrowAddress({
    keys: {
      customer: order.customerXonly ?? '11'.repeat(32),
      sponsor: sponsorXonly,
      admin: '22'.repeat(32),
    },
    network: order.network,
  });
}

// ─── ③ 보증금 결제 감시 (워처 phase 0) ───────────────────────

export async function checkOnchainDeposits(): Promise<void> {
  if (!lnAdapter) return;

  for (const deposit of getOnchainDeposits()) {
    try {
      const status = await lnAdapter.lookupHoldInvoice(deposit.depositPaymentHash);
      if (status === 'accepted') {
        await onDepositAccepted(deposit);
      } else if (status === 'cancelled') {
        deleteOnchainDeposit(depositKey(deposit));
        const who = deposit.type === 'sponsor' ? deposit.sponsorPubkey : deposit.customerPubkey;
        if (who) {
          void publishOnchainDepositStatus(deposit.orderId, who, 'cancelled', onchainMessageExpiration(now()))
            .catch(e => console.warn('[Onchain] 보증금 통지 실패', e));
        }
      }
      // open → 아직 미결제. 다음 틱에 다시 본다.
    } catch (e) {
      console.warn('[Onchain] 보증금 조회 실패', deposit.orderId, e);
    }
  }
}

async function onDepositAccepted(deposit: OnchainPendingDeposit): Promise<void> {
  if (deposit.type === 'customer') {
    if (getOnchainOrder(deposit.orderId)) {
      deleteOnchainDeposit(depositKey(deposit));
      return;
    }
    const order: OnchainOrder = {
      orderId: deposit.orderId,
      state: 'listed',
      status: 'active',
      customerPubkey: deposit.customerPubkey,
      amountSat: deposit.tradeAmountSat ?? 0,
      reserveKrw: deposit.reserveKrw,
      createdAt: now(),
      updatedAt: now(),
      expiration: deposit.expiration ?? 0,
      network,
      customerXonly: deposit.customerXonly,
      customerDepositHash: deposit.depositPaymentHash,
      raw: {},
    };
    mergeEscrowMeta(deposit.orderId, {
      refundAddress: deposit.refundAddress,
      customerBondExpiresAt: deposit.cltvBlocks ? now() + deposit.cltvBlocks * BLOCK_SEC : undefined,
    });
    upsertOnchainOrder(order);
    try {
      await publishOnchainOrder(order);
    } catch (e) {
      // 발행이 실패하면 보증금 대기를 **지우지 않는다** — 다음 틱에 다시 시도한다.
      return console.warn('[Onchain] 오더 발행 실패, 재시도한다', deposit.orderId, e);
    }
    deleteOnchainDeposit(depositKey(deposit));
    void publishOnchainDepositStatus(
      deposit.orderId, deposit.customerPubkey, 'accepted', onchainMessageExpiration(now()),
    ).catch(e => console.warn('[Onchain] 보증금 통지 실패', e));
    console.log('[Onchain] 의뢰 등록', deposit.orderId);
    return;
  }

  // ── 후원자 보증금 = **클레임 성립** (§4.1b) ──
  const order = getOnchainOrder(deposit.orderId);
  if (!order) return;

  // ⚠️ **이긴 쪽의 보증금이면 건드리지 않는다.** 백업 복원이 이미 처리해 지운 항목을
  // 되살릴 수 있는데(3초 디바운스 안에 탭을 닫았거나 백업 발행이 실패했을 때), 그걸
  // "진 쪽"으로 보고 취소하면 **살아 있는 보증금이 환불**돼 후원자가 아무것도 안 건 채
  // 거래를 계속한다(리뷰 #8). 처리는 결정 시점의 보증금 로직이 맡는다.
  if (order.sponsorDepositHash === deposit.depositPaymentHash) {
    deleteOnchainDeposit(depositKey(deposit));
    return;
  }

  if (order.state !== 'listed') {
    // 먼저 결제한 쪽이 이미 가져갔다. 이 HTLC는 취소한다 — **실패라 수수료 0**이다.
    await cancelDeposit(deposit);
    return;
  }
  if (!deposit.sponsorPubkey || !deposit.sponsorXonly) return;

  // ⚠️ 어드민 키는 **백업이 확인돼야** 만들어진다. 실패하면 주소를 발행하지 않는다(공격 M).
  let adminXonly: string;
  try {
    adminXonly = (await createOrderKeyWithBackup(deposit.orderId)).xonly;
  } catch (e) {
    return console.error('[Onchain] 어드민 키 백업 실패 — 주소를 발행하지 않는다', deposit.orderId, e);
  }

  const descriptor = escrowDescriptorFor({
    ...order, sponsorXonly: deposit.sponsorXonly, adminXonly,
  });
  if (!descriptor) {
    // 키가 겹치거나 형식이 틀렸다 — 이 후보로는 영영 안 된다. 돌려주고 치운다.
    console.error('[Onchain] 에스크로 주소를 만들지 못했다 — 이 보증금을 돌려준다', deposit.orderId);
    await cancelDeposit(deposit);
    return;
  }

  mergeEscrowMeta(deposit.orderId, {
    payoutAddress: deposit.payoutAddress,
    feerateSatPerVb: deposit.feerateSatPerVb,
    sponsorDepositKey: deposit.escrowKey,
    sponsorBondExpiresAt: deposit.cltvBlocks ? now() + deposit.cltvBlocks * BLOCK_SEC : undefined,
  });

  const updated = await commitOnchainOrder(deposit.orderId, {
    state: 'bonded',
    sponsorPubkey: deposit.sponsorPubkey,
    sponsorXonly: deposit.sponsorXonly,
    adminXonly,
    escrowAddress: descriptor.address,
    timelockBlocks: descriptor.timelockBlocks,
    fundingDeadline: now() + FUNDING_WINDOW_SEC,
    sponsorDepositHash: deposit.depositPaymentHash,
  }, { ifUnchangedSince: order.updatedAt });
  if (!updated) return;

  deleteOnchainDeposit(depositKey(deposit));
  void publishOnchainDepositStatus(
    deposit.orderId, deposit.sponsorPubkey, 'accepted', onchainMessageExpiration(now()),
  ).catch(e => console.warn('[Onchain] 보증금 통지 실패', e));

  // 나머지 후보들의 인보이스를 치운다 (HTLC 실패라 수수료 0)
  for (const other of getOnchainDepositsFor(deposit.orderId)) {
    if (other.type === 'sponsor') await cancelDeposit(other);
  }
  console.log('[Onchain] 클레임 성립 →', descriptor.address);
}

async function cancelDeposit(deposit: OnchainPendingDeposit): Promise<void> {
  try {
    await lnAdapter?.cancelInvoice(deposit.depositPaymentHash);
  } catch (e) {
    console.warn('[Onchain] 보증금 취소 실패', deposit.orderId, e);
  }
  deleteOnchainDeposit(depositKey(deposit));
  if (deposit.sponsorPubkey) {
    void publishOnchainDepositStatus(
      deposit.orderId, deposit.sponsorPubkey, 'cancelled', onchainMessageExpiration(now()),
    ).catch(e => console.warn('[Onchain] 보증금 통지 실패', e));
  }
}

// ─── ④ 사전서명 ──────────────────────────────────────────────

export async function handleOnchainPresig(req: OnchainPresigMsg): Promise<void> {
  const order = getOnchainOrder(req.orderId);
  if (!order) return;
  if (req.pubkey !== order.sponsorPubkey) {
    return console.warn('[Onchain] 후원자가 아닌 쪽의 사전서명', req.orderId);
  }
  const reject = (reason: string) => rejectTo(req.orderId, req.pubkey, reason);

  // 마감을 **핸들러가 직접** 본다. 워처 틱 사이에 들어온 늦은 사전서명을 받아주면,
  // 이미 환불로 넘어간 거래가 다시 굴러간다(리뷰 #8).
  if (order.state !== 'funded' || order.settlementKind) {
    return reject('사전서명을 받을 수 없는 단계입니다 — 마감이 지나 환불로 넘어갔을 수 있습니다');
  }
  if (isPast(presignDeadlineOf(order), now())) {
    return reject('사전서명 마감(가격 확정 후 15분)이 지났습니다');
  }

  const meta = getEscrowMeta(req.orderId);
  const expected = settlementParamsFor(order, 'release');
  if (!meta?.payoutAddress || !expected) {
    return console.warn('[Onchain] 사전서명을 검증할 재료가 없다', req.orderId);
  }

  let payload: unknown;
  try {
    payload = await decryptFrom(req.pubkey, contentOf(req));
  } catch (e) {
    return console.warn('[Onchain] 사전서명 암호문을 못 열었다', req.orderId, e);
  }
  if (!isOnchainPsbtPayload(payload)) return;

  // ⚠️ **우리가 직접 만든 tx**와 대조한다. 상대가 준 값으로 기대치를 만들면 검증이 아니다.
  const verdict = verifyPresignature({
    psbtBase64: payload.psbt,
    expected,
    signerXonly: order.sponsorXonly!,
  });
  if (!verdict.ok) {
    return reject(`사전서명이 맞지 않습니다: ${verdict.reason} — 클레임 때 낸 받을 주소·수수료율과 같은지 확인하세요`);
  }

  mergeEscrowMeta(req.orderId, { presigPsbt: payload.psbt });

  const at = now();
  const updated = await commitOnchainOrder(
    req.orderId, { state: 'presigned', presignedAt: at }, { ifUnchangedSince: order.updatedAt },
  );
  if (!updated) return;

  // 고객이 나중에 릴리스에 서명할 수 있도록 **지금** 보낸다. 안에 든 건 **후원자 서명뿐**이다 —
  // 고객 서명 없이는 아무것도 완성되지 않는다. 전달이 실패하면 워처가 재촉하지 않으므로
  // 어드민 화면의 "다시 보내기"가 그 자리다(릴리스는 `remitted` 이후에만 의미가 있다).
  try {
    await publishOnchainSignRequest(req.orderId, order.customerPubkey, 'release', payload.psbt);
  } catch (e) {
    console.error('[Onchain] 릴리스 PSBT 전달 실패 — 재전송이 필요하다', req.orderId, e);
  }
  console.log('[Onchain] 사전서명 검증 완료', req.orderId);
}

/** 릴리스 PSBT(후원자 사전서명)를 고객에게 다시 보낸다 — 어드민 화면 버튼 */
export async function resendReleaseRequest(order: OnchainOrder): Promise<void> {
  const presig = getEscrowMeta(order.orderId)?.presigPsbt;
  if (!presig) throw new Error('사전서명 기록이 없다');
  await publishOnchainSignRequest(order.orderId, order.customerPubkey, 'release', presig);
}

// ─── ⑤ 최종 서명 → 발행 → 브로드캐스트 ───────────────────────

export async function handleOnchainCosign(req: OnchainCosignMsg): Promise<void> {
  if (req.purpose === 'rescue') return handleOnchainRescueCosign(req);
  if (!chain) return;
  const order = getOnchainOrder(req.orderId);
  if (!order) return;

  // **진실은 FSM이다** — 화면만 막으면 수정한 클라이언트가 `remitted`에서 환불 서명을
  // 보내 원화와 BTC를 다 가져간다(리뷰 #8). 어드민도 같은 함수로 막는다.
  if (!canActOnSignRequest(order.state, req.purpose, order.settlementKind)) {
    return console.warn('[Onchain] 이 상태에서는 받지 않는 서명', req.orderId, order.state, req.purpose);
  }
  const kind: SettlementKind | undefined = req.purpose === 'release' ? 'release' : order.settlementKind;
  if (!kind || signPurposeFor(kind) !== req.purpose) {
    return console.warn('[Onchain] 결정된 사유와 맞지 않는 서명', req.orderId, kind, req.purpose);
  }

  const signerRole = awaitingSignerFor(kind);
  const expectedSender = signerRole === 'sponsor' ? order.sponsorPubkey : order.customerPubkey;
  const signerXonly = signerRole === 'sponsor' ? order.sponsorXonly : order.customerXonly;
  if (req.pubkey !== expectedSender || !signerXonly) {
    return console.warn('[Onchain] 서명자가 맞지 않는다', req.orderId, req.purpose);
  }

  const expected = settlementParamsFor(order, kind);
  if (!expected) return console.warn('[Onchain] 이 서명을 붙일 tx를 만들 수 없다', req.orderId, kind);

  let payload: unknown;
  try {
    payload = await decryptFrom(req.pubkey, contentOf(req));
  } catch (e) {
    return console.warn('[Onchain] 최종 서명 암호문을 못 열었다', req.orderId, e);
  }
  if (!isOnchainPsbtPayload(payload)) return;

  const verdict = verifyPresignature({ psbtBase64: payload.psbt, expected, signerXonly });
  if (!verdict.ok) {
    return console.warn('[Onchain] 최종 서명 거부:', req.orderId, verdict.reason);
  }

  // 우리 tx를 **다시 만들고** 검증한 서명만 옮겨 심는다 — 받은 PSBT를 그대로 완성하지 않는다.
  let rawHex: string;
  let txid: string;
  try {
    const tx = buildSettlementTx(expected);
    addTapScriptSig(tx, verdict.leafScript, signerXonly, verdict.sig);

    if (kind === 'release') {
      // 후원자 서명은 `presigned`에서 **우리가 검증해 보관한 것**을 쓴다.
      const presig = getEscrowMeta(order.orderId)?.presigPsbt;
      const sponsor = presig
        ? verifyPresignature({ psbtBase64: presig, expected, signerXonly: order.sponsorXonly! })
        : null;
      if (!sponsor?.ok) {
        return console.error('[Onchain] 보관한 사전서명이 이 tx와 맞지 않는다', req.orderId);
      }
      addTapScriptSig(tx, sponsor.leafScript, order.sponsorXonly!, sponsor.sig);
    } else {
      // **어드민은 마지막에 서명한다.** 이 순간 전까지 고객 손에 완성 가능한 tx가 없다.
      const adminKey = await getOrderKey(order.orderId, order.adminXonly);
      if (!adminKey) return console.error('[Onchain] 어드민 키가 없다 — 중재 불가', req.orderId);
      signSettlement(tx, adminKey.privkey);
    }

    finalizeSettlement(tx, expected.path);
    rawHex = tx.hex;
    txid = tx.id;
  } catch (e) {
    return console.warn('[Onchain] 종결 tx를 완성하지 못했다', req.orderId, e);
  }

  await settleThroughOutbox(order, kind, txid, rawHex);
}

/**
 * **발행 → 브로드캐스트** 순서로 종결한다 (리뷰 #8).
 *
 * 1. raw tx를 outbox(메타, 백업된다)에 남긴다
 * 2. `settling`을 발행한다 — 그 사이 오더가 바뀌었으면 쓰지 않는다
 * 3. 그 뒤에만 뿌린다
 *
 * 2가 실패하면 체인에 아무것도 안 뜨고 outbox가 남는다 → 워처가 다시 시도한다.
 * 3이 실패하면 `settling`인 채 워처가 다시 뿌린다(O-005).
 */
async function settleThroughOutbox(
  order: OnchainOrder,
  kind: SettlementKind,
  txid: string,
  rawHex: string,
): Promise<boolean> {
  if (!chain) return false;
  mergeEscrowMeta(order.orderId, { outbox: { txid, rawHex, kind } });

  const updated = await commitOnchainOrder(order.orderId, {
    state: 'settling',
    settlementKind: kind,
    settlementTxid: txid,
    settlingAt: now(),
  }, { ifUnchangedSince: order.updatedAt });
  if (!updated) {
    console.warn('[Onchain] settling 발행 실패 — 브로드캐스트하지 않는다(워처가 다시 시도)', order.orderId);
    return false;
  }

  const sent = await chain.broadcastTx(rawHex);
  if (!sent.known) {
    console.warn('[Onchain] 브로드캐스트 실패 — 워처가 다시 뿌린다:', order.orderId, sent.reason);
  } else {
    console.log('[Onchain] 종결 브로드캐스트', order.orderId, kind, sent.value);
  }
  return true;
}

/** 워처: outbox에 남은 것을 마무리한다 (발행 실패 뒤 재시도) */
export async function flushOnchainOutbox(order: OnchainOrder): Promise<void> {
  const outbox = getEscrowMeta(order.orderId)?.outbox;
  if (!outbox || order.state === 'settling' || isOnchainTerminal(order.state)) return;
  const kind = outbox.kind as SettlementKind;

  // 그 사이 상태가 바뀌었어도 **이 사유의 종결이 아직 허용되는지** 본다.
  const purpose = signPurposeFor(kind);
  if (!canActOnSignRequest(order.state, purpose, order.settlementKind)
      || !canOnchainTransition(order.state, 'settling')) {
    console.error('[Onchain] outbox의 종결이 지금 상태와 맞지 않는다', order.orderId, order.state, kind);
    return;
  }
  await settleThroughOutbox(order, kind, outbox.txid, outbox.rawHex);
}

/** 워처: 멤풀에서 쫓겨난 우리 종결 tx를 **같은 바이트로** 다시 뿌린다 (O-005) */
export async function rebroadcastSettlement(order: OnchainOrder): Promise<void> {
  if (!chain) return;
  const outbox = getEscrowMeta(order.orderId)?.outbox;
  if (!outbox || outbox.txid !== order.settlementTxid) return;
  const sent = await chain.broadcastTx(outbox.rawHex);
  console.log('[Onchain] 종결 재브로드캐스트', order.orderId, sent.known ? 'ok' : sent.reason);
}

/** 워처: outbox에 남은 txid (없으면 `undefined`) */
export function outboxTxidFor(orderId: string): string | undefined {
  return getEscrowMeta(orderId)?.outbox?.txid;
}

// ─── ⑤b 원화 송금 주장 ───────────────────────────────────────

/**
 * 후원자가 "원화 보냈다" → `presigned → remitted`.
 *
 * ⚠️ **이건 후원자의 일방적 주장이다**(O-007). 여기서 릴리스가 나가지 않는다 —
 * 고객이 은행을 확인하고 서명해야만 BTC가 움직인다.
 *
 * ⚠️ **송금 마감이 지나면 받지 않는다**(리뷰 #8). 전에는 마감 뒤 주장도 받아서,
 * 환불이 이미 걸린 거래가 `remitted`로 굴러갔다.
 */
export async function handleOnchainRemit(req: { orderId: string; pubkey: string }): Promise<void> {
  const order = getOnchainOrder(req.orderId);
  if (!order) return;
  if (req.pubkey !== order.sponsorPubkey) {
    return console.warn('[Onchain] 후원자가 아닌 쪽의 송금 주장', req.orderId);
  }
  const reject = (reason: string) => rejectTo(req.orderId, req.pubkey, reason);
  if (order.state !== 'presigned' || order.settlementKind) {
    return reject('송금 완료를 받을 수 없는 단계입니다 — 마감이 지나 환불로 넘어갔을 수 있습니다');
  }
  // 계좌가 나가기 전에 "보냈다"는 성립할 수 없다.
  if (!order.accountSentAt) return reject('고객 계좌가 아직 전달되지 않았습니다');
  if (isPast(krwDeadlineOf(order), now())) return reject('원화 송금 마감이 지났습니다');

  await commitOnchainOrder(
    req.orderId, { state: 'remitted', remittedAt: now() }, { ifUnchangedSince: order.updatedAt },
  );
}

// ─── ⑤c 고객이 의뢰를 접는다 ─────────────────────────────────

/**
 * 고객이 스스로 의뢰를 내린다 → `listed → cancelled`, **보증금 환불**.
 *
 * ⚠️ **`listed`에서만** 받는다. 후원자 보증금이 잡힌 뒤(`bonded`)에는 일방
 * 취소가 없다 — 상대가 이미 돈을 걸었고, 그때부터는 마감과 체인이 판정한다
 * (§4.2 · O-001). 라이트닝 트랙이 `escrowed` 이후 취소를 닫아둔 것과 같은 이유다.
 */
export async function handleOnchainCancelRequest(
  req: { orderId: string; pubkey: string },
): Promise<void> {
  const order = getOnchainOrder(req.orderId);
  if (!order) return;
  if (req.pubkey !== order.customerPubkey) {
    return console.warn('[Onchain] 의뢰자가 아닌 쪽의 취소 요청', req.orderId);
  }
  if (order.state !== 'listed') {
    return rejectTo(req.orderId, req.pubkey, '후원자가 이미 붙어 의뢰를 내릴 수 없습니다');
  }

  const updated = await commitOnchainOrder(
    req.orderId, { state: 'cancelled' }, { ifUnchangedSince: order.updatedAt },
  );
  if (!updated) return;

  // 사유가 곧 보증금 처리다 — 후원자가 없었으니 고객 보증금은 **환불**이다(§4.1b).
  void handleOnchainOutcome(updated, 'cancel:customer', lnAdapter);

  // 아직 결제 안 된 후원자 인보이스를 먼저 치운다. 안 그러면 취소된 뒤에 결제해
  // "냈는데 늦었다"를 겪는다 — HTLC는 실패라 잃는 건 없지만 헛걸음이다.
  for (const deposit of getOnchainDepositsFor(req.orderId)) {
    if (deposit.type === 'sponsor') await cancelDeposit(deposit);
  }
  console.log('[Onchain] 고객이 의뢰를 접었다', req.orderId);
}

// ─── ⑥ 분쟁 ──────────────────────────────────────────────────

export async function handleOnchainDispute(req: OnchainDisputeMsg): Promise<void> {
  const order = getOnchainOrder(req.orderId);
  if (!order) return;
  if (req.pubkey !== order.customerPubkey && req.pubkey !== order.sponsorPubkey) return;

  if (order.state === 'remitted') {
    await commitOnchainOrder(
      req.orderId, { state: 'disputed', disputedAt: now() }, { ifUnchangedSince: order.updatedAt },
    );
    return;
  }

  // ⚠️ **계좌 이의는 상태가 아니다** (§5.2b). 상태로 받으면 원화 마감 시계가
  // 멈추고 그 순간 무한 옵션이 열린다(§7.6 R4-H1). 마감은 그대로 흐르고,
  // 이 주장은 **누구 과실인지 사람이 가를 거리**로만 남는다 — 전에는 콘솔에만 남아
  // 판정할 방법이 없었다(리뷰 #8). 오더에 시각을 박아 두고, 마감이 차면
  // `refund:account-disputed`로 보증금을 붙잡는다.
  if (order.state === 'presigned' && req.stage === 'account-unusable') {
    const ok = req.pubkey === order.sponsorPubkey
      && order.accountSentAt !== undefined
      && !order.accountDisputedAt
      && !order.settlementKind
      && !isPast(krwDeadlineOf(order), now());
    if (!ok) {
      return rejectTo(req.orderId, req.pubkey, '계좌 이의는 계좌를 받은 뒤 송금 마감 전에만 낼 수 있습니다');
    }
    await commitOnchainOrder(
      req.orderId, { accountDisputedAt: now() }, { ifUnchangedSince: order.updatedAt },
    );
    console.warn('[Onchain] 계좌 이의 접수 (시계는 계속 간다):', req.orderId);
    return;
  }

  return rejectTo(req.orderId, req.pubkey, '이 단계에서는 분쟁을 열 수 없습니다');
}

// ─── ⑦ 종결 결정 (워처·어드민 판정) ──────────────────────────

/**
 * 종결을 **결정**한다 — 사유와 수수료를 오더에 박고, 보증금을 처리하고, 서명을 요청한다.
 *
 * - 환불(`refund:*`) → `refunding`으로 간다. `fold`면 `bonded`에서 바로 간다
 *   (가격을 고정하지 않고 접는다 — reserve 미달·보증금 만료)
 * - 분쟁 판정(`sponsor_win`·`customer_win`) → 상태는 `disputed` 그대로, 판정이 박힌다
 *
 * **보증금은 여기서 처리한다**(리뷰 #8). 종결 tx 컨펌 때 처리하면 몰수당할 쪽이
 * 서명을 미뤄 HTLC 만료를 기다릴 수 있었다.
 *
 * 결정은 **되돌리지 않는다.** 판정 버튼이 확인을 받는 이유다.
 */
export async function decideOnchainSettlement(
  order: OnchainOrder,
  kind: SettlementKind,
  opts: { fold?: { outpoint: Outpoint; confirmations: number } } = {},
): Promise<OnchainOrder | null> {
  if (!chain) return null;

  const ruling = kind === 'sponsor_win' || kind === 'customer_win';
  if (ruling) {
    if (order.state !== 'disputed' || order.settlementKind) return null;
  } else if (isRefundKind(kind)) {
    const allowed = opts.fold ? order.state === 'bonded' : order.state === 'funded' || order.state === 'presigned';
    if (!allowed || order.settlementKind) return null;
  } else {
    return null; // 릴리스는 결정하는 게 아니다 — 고객이 서명해야만 나간다(O-007)
  }

  const fees = await currentFees();
  if (!fees) return null;

  // `fold`는 아직 outpoint가 오더에 없다 — 이번 결정과 같이 박는다.
  const draft: OnchainOrder = opts.fold
    ? { ...order, fundingOutpoint: formatOutpoint(opts.fold.outpoint.txid, opts.fold.outpoint.vout) }
    : order;
  const shape = settlementParamsFor(draft, kind, 0);
  if (!shape) {
    console.error('[Onchain] 종결 재료가 없다', order.orderId, kind);
    return null;
  }

  let feeSat: number;
  try {
    // ⚠️ **수수료를 새로 추정한다.** `releaseFeeSat`은 T0에 고정된 값이라
    // 분쟁이 몇 주 뒤에 끝나면 낡는다 — 그대로 쓰면 tx가 멤풀에서 썩는다(§6.1).
    feeSat = settlementFeeSat(shape.path, shape.descriptor, shape.destination, fees.halfHour);
    buildSettlementTx({ ...shape, feeSat }); // dust 등 — 만들 수 있는 tx인지 지금 확인한다
  } catch (e) {
    console.error('[Onchain] 종결 tx를 만들 수 없다', order.orderId, kind, e);
    return null;
  }

  const patch: OnchainPatch = {
    settlementKind: kind,
    settlementFeeSat: feeSat,
    decidedAt: now(),
    ...(ruling ? {} : { state: 'refunding' as const }),
    ...(opts.fold ? { fundingOutpoint: draft.fundingOutpoint, fundingConfs: opts.fold.confirmations } : {}),
  };
  const updated = await commitOnchainOrder(order.orderId, patch, { ifUnchangedSince: order.updatedAt });
  if (!updated) return null;

  await handleOnchainOutcome(updated, kind, lnAdapter);
  // 판정은 상태가 안 바뀌어 전이 알림이 없다 — 이긴 쪽이 서명해야 집행되므로 따로 알린다.
  if (ruling) notifyOnchainRuling(updated);
  await requestSettlementSignature(updated);
  console.log('[Onchain] 종결 결정', order.orderId, kind, feeSat, 'sat');
  return updated;
}

/**
 * 결정된 종결의 서명을 요청한다 — **서명 없는** PSBT를 보낸다.
 *
 * 받는 쪽은 이 PSBT를 믿지 않고 자기 기록으로 같은 tx를 다시 만들어 서명한다.
 * 여기 담긴 건 사실상 "수수료가 얼마인가" 하나다.
 */
export async function requestSettlementSignature(order: OnchainOrder): Promise<void> {
  const kind = order.settlementKind;
  if (!kind || kind === 'release') return;
  const params = settlementParamsFor(order, kind);
  if (!params) return console.error('[Onchain] 서명 요청을 만들 재료가 없다', order.orderId);

  const recipient = awaitingSignerFor(kind) === 'sponsor' ? order.sponsorPubkey : order.customerPubkey;
  if (!recipient) return;
  markSignatureRequested(order.orderId, now());
  try {
    const psbt = toPsbtBase64(buildSettlementTx(params));
    await publishOnchainSignRequest(order.orderId, recipient, signPurposeFor(kind), psbt);
  } catch (e) {
    // 기록은 남는다 — 워처가 간격을 두고 다시 보낸다.
    console.error('[Onchain] 종결 서명 요청 전달 실패', order.orderId, e);
  }
}

/**
 * 계좌 이의를 판정한다 — 잠정 사유(`refund:account-disputed`)를 확정한다(§5.2b).
 *
 * - `account-bad` — 계좌가 정말 못 쓰는 것이었다 → `refund:customer-late` (고객 몰수)
 * - `sponsor-fault` — 이의에 근거가 없다 → `refund:sponsor-timeout` (후원자 몰수)
 *
 * 환불 tx는 사유와 무관하게 같은 모양이라 고객 서명은 그대로 유효하다.
 * §7.7 입증책임 — 몰수를 면하려는 쪽(후원자)이 증명한다. 어드민이 직접 확인할 수
 * 없는 주장은 인정하지 않는다.
 */
export async function resolveAccountDispute(
  order: OnchainOrder,
  verdict: 'account-bad' | 'sponsor-fault',
): Promise<OnchainOrder | null> {
  if (order.settlementKind !== 'refund:account-disputed') return null;
  if (order.state !== 'refunding' && order.state !== 'settling' && order.state !== 'refunded') return null;
  const kind: SettlementKind = verdict === 'account-bad' ? 'refund:customer-late' : 'refund:sponsor-timeout';
  const updated = await commitOnchainOrder(
    order.orderId, { settlementKind: kind }, { ifUnchangedSince: order.updatedAt },
  );
  if (updated) await handleOnchainOutcome(updated, kind, lnAdapter);
  return updated;
}

// ─── ⑧ 계좌 정보 게이트 ──────────────────────────────────────

/**
 * 고객이 계좌를 공개한 시점을 기록한다 (O-002·O-003·O-013).
 *
 * ⚠️ **보낸 사람을 본다**(리뷰 #8). 전에는 이 알림을 아무나 보낼 수 있었다 — 제3자가
 * 가짜 계좌를 후원자에게 보내면서 이걸로 후원자 30분 시계까지 시작시키면, 진짜 고객의
 * 계좌 입력 폼은 사라지고 후원자는 공격자 계좌로 송금했다.
 *
 * 계좌 공개 마감이 지나면 받지 않는다 — 환불(`refund:customer-late`)이 결정될 자리다.
 */
export async function noteAccountInfoSent(
  orderId: string,
  senderPubkey: string,
  commitment?: string,
): Promise<void> {
  const order = getOnchainOrder(orderId);
  if (!order) return;
  if (senderPubkey !== order.customerPubkey) {
    return console.warn('[Onchain] 고객이 아닌 쪽이 보낸 계좌 알림 — 무시', orderId, senderPubkey.slice(0, 8));
  }
  if (order.state !== 'presigned' || order.accountSentAt || order.settlementKind) return;
  if (isPast(accountDeadlineOf(order), now())) {
    return rejectTo(orderId, senderPubkey, '계좌 공개 마감이 지나 거래가 환불로 넘어갑니다');
  }

  if (commitment) mergeEscrowMeta(orderId, { accountCommitment: commitment });

  const at = now();
  const updated = await commitOnchainOrder(orderId, {
    accountSentAt: at,
    // ⚠️ 후원자 마감은 **여기서부터** 센다. 고객 지연이 후원자 창을 깎지 않는다.
    krwDeadline: krwDeadlineFrom(at),
  }, { ifUnchangedSince: order.updatedAt });
  // 상태가 안 바뀌므로 전이 알림이 안 뜬다. 후원자가 움직일 수 있게 되는
  // 순간이 정확히 여기라 따로 보낸다.
  if (updated) notifyOnchainAccountArrived(updated);
}

/** 워처가 쓰는 "계좌가 나갔는가" */
export function accountInfoSent(orderId: string): boolean {
  return Boolean(getOnchainOrder(orderId)?.accountSentAt);
}

// ─── ⑨ 구조 (약정 밖의 자금 → 고객) ──────────────────────────

/**
 * 약정 밖의 자금 하나를 고객에게 돌려주는 요청을 보낸다 (리뷰 #8).
 *
 * 금액이 틀린 펀딩, 이중 송금, 취소 뒤 늦게 컨펌된 펀딩, 확정 뒤 추가 입금 — 전에는
 * 전부 8주 타임락이 유일한 출구였다. `{A,C}` 리프로 **고객이 낸 환불 주소**에 보낸다.
 *
 * ⚠️ **진행 중인 거래의 에스크로는 구조 대상이 아니다** — 그건 종결 tx가 쓴다.
 * 후원자가 원화를 보낸 뒤 에스크로를 고객에게 돌리면 그게 탈취다.
 *
 * @returns 거절 사유. 보냈으면 `null`
 */
export async function requestOnchainRescue(
  order: OnchainOrder,
  utxo: { txid: string; vout: number; valueSat: number },
): Promise<string | null> {
  if (!chain) return '체인 어댑터가 없다';
  if (isPinnedOfLiveTrade(order, utxo)) return '진행 중인 거래의 에스크로는 구조할 수 없다';

  const descriptor = escrowDescriptorFor(order);
  const destination = refundDestinationFor(order);
  if (!descriptor || !destination) return '에스크로·환불 주소를 만들 수 없다';

  const fees = await currentFees();
  if (!fees) return '수수료를 조회하지 못했다';

  let psbt: string;
  let feeSat: number;
  try {
    feeSat = settlementFeeSat('refund', descriptor, destination, fees.halfHour);
    psbt = toPsbtBase64(buildSettlementTx({
      descriptor, input: { outpoint: utxo, valueSat: utxo.valueSat },
      path: 'refund', destination, feeSat,
    }));
  } catch (e) {
    return `구조 tx를 만들 수 없다: ${e instanceof Error ? e.message : String(e)}`;
  }

  putRescue({ orderId: order.orderId, ...utxo, feeSat, destination, createdAt: now() });
  try {
    await publishOnchainSignRequest(order.orderId, order.customerPubkey, 'rescue', psbt);
  } catch (e) {
    return `서명 요청 전달 실패: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
}

function isPinnedOfLiveTrade(order: OnchainOrder, utxo: { txid: string; vout: number }): boolean {
  const pinned = parseOutpoint(order.fundingOutpoint);
  if (!pinned || pinned.txid !== utxo.txid || pinned.vout !== utxo.vout) return false;
  return !isOnchainTerminal(order.state);
}

async function handleOnchainRescueCosign(req: OnchainCosignMsg): Promise<void> {
  if (!chain) return;
  const order = getOnchainOrder(req.orderId);
  if (!order || req.pubkey !== order.customerPubkey || !order.customerXonly) return;

  let payload: unknown;
  try {
    payload = await decryptFrom(req.pubkey, contentOf(req));
  } catch (e) {
    return console.warn('[Onchain] 구조 서명 암호문을 못 열었다', req.orderId, e);
  }
  if (!isOnchainPsbtPayload(payload)) return;

  // 어느 UTXO에 대한 서명인지는 PSBT 입력에서 읽고, **나머지는 우리 기록**으로 만든다.
  let outpoint: Outpoint;
  try {
    const input = fromPsbtBase64(payload.psbt).getInput(0);
    if (!input?.txid || input.index === undefined) throw new Error('입력이 없다');
    outpoint = { txid: bytesToHex(input.txid), vout: input.index };
  } catch (e) {
    return console.warn('[Onchain] 구조 PSBT를 읽지 못했다', req.orderId, e);
  }
  const rescue = getRescue(order.orderId, outpoint.txid, outpoint.vout);
  if (!rescue) return console.warn('[Onchain] 요청한 적 없는 구조', req.orderId, outpoint);
  if (rescue.broadcastTxid) return;
  if (isPinnedOfLiveTrade(order, outpoint)) {
    return console.error('[Onchain] 진행 중인 거래의 에스크로를 구조하려 했다', req.orderId);
  }

  const descriptor = escrowDescriptorFor(order);
  if (!descriptor) return;
  const expected: BuildSettlementParams = {
    descriptor,
    input: { outpoint, valueSat: rescue.valueSat },
    path: 'refund',
    destination: rescue.destination,
    feeSat: rescue.feeSat,
  };
  const verdict = verifyPresignature({ psbtBase64: payload.psbt, expected, signerXonly: order.customerXonly });
  if (!verdict.ok) return console.warn('[Onchain] 구조 서명 거부', req.orderId, verdict.reason);

  try {
    const tx = buildSettlementTx(expected);
    addTapScriptSig(tx, verdict.leafScript, order.customerXonly, verdict.sig);
    const adminKey = await getOrderKey(order.orderId, order.adminXonly);
    if (!adminKey) return console.error('[Onchain] 어드민 키가 없다 — 구조 불가', req.orderId);
    signSettlement(tx, adminKey.privkey);
    finalizeSettlement(tx, 'refund');
    const sent = await chain.broadcastTx(tx.hex);
    if (!sent.known) return console.warn('[Onchain] 구조 브로드캐스트 실패', req.orderId, sent.reason);
    markRescueBroadcast(order.orderId, outpoint.txid, outpoint.vout, sent.value);
    console.log('[Onchain] 구조 브로드캐스트', req.orderId, sent.value);
  } catch (e) {
    console.warn('[Onchain] 구조 tx를 완성하지 못했다', req.orderId, e);
  }
}

/** 워처가 도는 대상 */
export function listOnchainOrders(): OnchainOrder[] {
  return Object.values(getSnapshot());
}

/** 어드민 pubkey로 오는 요청인지 (구독 필터 보조) */
export function isForAdmin(tags: string[][]): boolean {
  return tags.some(t => t[0] === 'p' && t[1] === APP_PUBKEY);
}
