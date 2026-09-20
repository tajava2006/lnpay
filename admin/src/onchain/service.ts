/**
 * 온체인 요청 핸들러 (PLAN-ONCHAIN-TRACK §5.2 · §9)
 *
 * 사람이 미는 쪽이다 — 의뢰 등록, 클레임, 사전서명, 최종 서명, 분쟁.
 * 체인이 미는 쪽은 `watcher.ts`가 맡는다.
 *
 * ── §9 자동화표를 그대로 따른다
 *
 * 판단이 필요 없는 건 전부 자동이다. **사람이 손대는 건 분쟁 판정 하나**다.
 * 그리고 자동화하면 안 되는 것도 하나 있다 — **릴리스 cosign**(O-007).
 * 여기서는 고객이 보낸 서명을 **집행**만 하고, 우리가 대신 만들지 않는다.
 */
import type { LightningAdapter } from '../lightning';
import { APP_PUBKEY } from '@sajwo-tracker/shared';
import type {
  OnchainClaimMsg, OnchainCosignMsg, OnchainDisputeMsg,
  OnchainOrderRequestMsg, OnchainPresigMsg,
} from '@sajwo-tracker/shared/onchain';
import {
  FUNDING_WINDOW_SEC, TYPICAL_SETTLEMENT_VSIZE,
  buildSettlementTx, canOnchainTransition, canSendAccountInfoOnchain,
  deriveEscrowAddress, deriveSingleKeyAddress, finalizeSettlement, fromPsbtBase64,
  isOnchainClaimPayload, isOnchainPsbtPayload, isOrderExpiryAllowed,
  krwDeadlineFrom, parseOutpoint, settlementFeeSat, signSettlement, toPsbtBase64,
  verifyPresignature,
  type BtcNetworkName, type EscrowDescriptor, type OnchainOrder, type SettlementKind,
  type SettlementPath,
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
  type OnchainPatch,
} from './order-store';
import {
  deleteOnchainDeposit, depositKey, getOnchainDeposits, getOnchainDepositsFor,
  putOnchainDeposit, type OnchainPendingDeposit,
} from './pending-deposit-store';
import {
  deletePendingSettlement, getPendingSettlement, putPendingSettlement,
} from './pending-settlement-store';
import { getEscrowMeta, mergeEscrowMeta } from './escrow-meta-store';
import {
  publishOnchainDepositRequired, publishOnchainDepositStatus, publishOnchainOrder,
  publishOnchainSignRequest,
} from './publish';
import { notifyOnchainAccountArrived, notifyOnchainTransition } from './notify';

// ─── 설정 ────────────────────────────────────────────────────

let lnAdapter: LightningAdapter | null = null;
let chain: ChainAdapter | null = null;
let network: BtcNetworkName = 'mainnet';

export function configureOnchainService(cfg: {
  lnAdapter?: LightningAdapter | null;
  chain?: ChainAdapter | null;
  network?: BtcNetworkName;
}): void {
  if (cfg.lnAdapter !== undefined) lnAdapter = cfg.lnAdapter;
  if (cfg.chain !== undefined) chain = cfg.chain;
  if (cfg.network !== undefined) network = cfg.network;
}

export function onchainNetwork(): BtcNetworkName {
  return network;
}

const now = () => Math.floor(Date.now() / 1000);

/** 보증금 인보이스가 받아야 할 CLTV 상한. 런타임에 채널에서 읽는 게 이상적이다(§2.2) */
const CLTV_CEILING_BLOCKS = 2016;

// ─── 공통 ────────────────────────────────────────────────────

/** 상태 전이 + 발행. 발행이 실패하면 **상태도 되돌린다** — 갈리면 양쪽이 다른 걸 본다 */
export async function commitOnchainOrder(
  orderId: string,
  patch: OnchainPatch,
): Promise<OnchainOrder | null> {
  const before = getOnchainOrder(orderId);
  const result = applyOnchainTransition(orderId, patch);
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
    if (before) upsertOnchainOrder({ ...before, updatedAt: result.order.updatedAt + 1 });
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

async function decryptFrom(senderPubkey: string, ciphertext: string): Promise<unknown> {
  const signer = getSigner();
  if (!signer) throw new Error('signer 없음');
  return JSON.parse(await signer.nip44Decrypt(senderPubkey, ciphertext)) as unknown;
}

function contentOf(req: { raw: object }): string {
  return (req.raw as { content?: string }).content ?? '';
}

/** 지금 feerate 기준 종결 tx 한 번의 수수료 — 보증금 하한의 재료 */
async function currentSettlementFeeSat(): Promise<number | null> {
  if (!chain) return null;
  const fees = await chain.getFeeEstimates();
  if (!fees.known) {
    console.warn('[Onchain] 수수료 추정 실패 — 보증금을 계산할 수 없다:', fees.reason);
    return null;
  }
  return Math.ceil(TYPICAL_SETTLEMENT_VSIZE * fees.value.halfHour);
}

// ─── ① 의뢰 등록 ─────────────────────────────────────────────

export async function handleOnchainOrderRequest(req: OnchainOrderRequestMsg): Promise<void> {
  if (!lnAdapter) return console.warn('[Onchain] LN 어댑터 없음 — 의뢰를 받을 수 없다');
  if (getOnchainOrder(req.orderId)) return;                      // 이미 오더가 있다
  if (getOnchainDepositsFor(req.orderId).length > 0) return;      // 이미 인보이스를 냈다

  // 만료 상한을 넘으면 보증금 CLTV가 채널 상한을 넘어 **인보이스를 못 만든다**(§2.2).
  if (!isOrderExpiryAllowed(req.expiration, now())) {
    return console.warn('[Onchain] 의뢰 만료가 허용 범위 밖이다:', req.orderId, req.expiration);
  }

  const settlementFee = await currentSettlementFeeSat();
  if (settlementFee === null) return;

  const floor = depositFloorSat(settlementFee);
  const minTrade = minTradeSat(floor);
  if (req.amountSat < minTrade) {
    // 이 아래로는 보증금이 거래액의 3%를 넘어 억제가 아니라 허들이 된다(§12 Q8).
    return console.warn(
      '[Onchain] 최소 거래액 미만:', req.orderId, req.amountSat, '<', minTrade,
    );
  }

  const cltv = depositCltvBlocks(req.expiration, now());
  if (cltv > CLTV_CEILING_BLOCKS) {
    return console.error('[Onchain] 보증금 CLTV가 채널 상한을 넘는다:', cltv);
  }

  const bondSat = depositSat(req.amountSat, CUSTOMER_DEPOSIT_PERCENT, floor);
  const invoice = await lnAdapter.createHoldInvoice(
    `onchain:${req.orderId}`, bondSat, req.expiration - now(), cltv,
  );

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
  });

  await publishOnchainDepositRequired(req.orderId, req.pubkey, invoice.bolt11, req.expiration);
  console.log('[Onchain] 고객 보증금 요구', req.orderId, bondSat, 'sat');
}

// ─── ② 클레임 ────────────────────────────────────────────────

export async function handleOnchainClaim(req: OnchainClaimMsg): Promise<void> {
  if (!lnAdapter) return;
  const order = getOnchainOrder(req.orderId);
  if (!order || order.state !== 'listed') return;                 // 이미 누가 가져갔다
  if (req.pubkey === order.customerPubkey) {
    return console.warn('[Onchain] 자기 의뢰를 자기가 클레임할 수 없다:', req.orderId);
  }

  const key = depositKey({ orderId: req.orderId, type: 'sponsor', sponsorPubkey: req.pubkey });
  if (getOnchainDeposits().some(d => depositKey(d) === key)) return; // 이미 발행했다

  let payload: unknown;
  try {
    payload = await decryptFrom(req.pubkey, contentOf(req));
  } catch (e) {
    return console.warn('[Onchain] 클레임 암호문을 못 열었다', req.orderId, e);
  }
  if (!isOnchainClaimPayload(payload)) {
    return console.warn('[Onchain] 클레임 페이로드가 이상하다', req.orderId);
  }

  // 받을 주소가 이 네트워크의 것인지 지금 확인한다 — 나중에 알면 종결 직전에 막힌다.
  try {
    deriveSingleKeyAddress(req.sponsorXonly, order.network);
    buildSettlementTx({
      descriptor: dummyDescriptorFor(order, req.sponsorXonly),
      input: { outpoint: { txid: '0'.repeat(64), vout: 0 }, valueSat: order.amountSat },
      path: 'release',
      destination: payload.payoutAddress,
      feeSat: 1,
    });
  } catch (e) {
    return console.warn('[Onchain] 후원자가 낸 주소를 쓸 수 없다', req.orderId, e);
  }

  const settlementFee = await currentSettlementFeeSat();
  if (settlementFee === null) return;

  const floor = depositFloorSat(settlementFee);
  const bondSat = depositSat(order.amountSat, SPONSOR_DEPOSIT_PERCENT, floor);
  const cltv = depositCltvBlocks(order.expiration, now());
  if (cltv > CLTV_CEILING_BLOCKS) return console.error('[Onchain] 보증금 CLTV 초과:', cltv);

  const invoice = await lnAdapter.createHoldInvoice(
    `onchain:${req.orderId}:${req.pubkey.slice(0, 8)}`, bondSat, order.expiration - now(), cltv,
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
    payoutAddress: payload.payoutAddress,
    feerateSatPerVb: payload.feerateSatPerVb,
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
          void publishOnchainDepositStatus(deposit.orderId, who, 'cancelled', deposit.createdAt + 86_400);
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
    upsertOnchainOrder(order);
    try {
      await publishOnchainOrder(order);
    } catch (e) {
      // 발행이 실패하면 보증금 대기를 **지우지 않는다** — 다음 틱에 다시 시도한다.
      return console.warn('[Onchain] 오더 발행 실패, 재시도한다', deposit.orderId, e);
    }
    deleteOnchainDeposit(depositKey(deposit));
    void publishOnchainDepositStatus(
      deposit.orderId, deposit.customerPubkey, 'accepted', order.expiration,
    );
    console.log('[Onchain] 의뢰 등록', deposit.orderId);
    return;
  }

  // ── 후원자 보증금 = **클레임 성립** (§4.1b) ──
  const order = getOnchainOrder(deposit.orderId);
  if (!order) return;

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
    return console.error('[Onchain] 에스크로 주소를 만들지 못했다', deposit.orderId);
  }

  mergeEscrowMeta(deposit.orderId, {
    payoutAddress: deposit.payoutAddress,
    feerateSatPerVb: deposit.feerateSatPerVb,
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
  });
  if (!updated) return;

  deleteOnchainDeposit(depositKey(deposit));
  void publishOnchainDepositStatus(
    deposit.orderId, deposit.sponsorPubkey, 'accepted', order.expiration,
  );

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
      deposit.orderId, deposit.sponsorPubkey, 'cancelled', deposit.createdAt + 86_400,
    );
  }
}

// ─── ④ 사전서명 ──────────────────────────────────────────────

export async function handleOnchainPresig(req: OnchainPresigMsg): Promise<void> {
  const order = getOnchainOrder(req.orderId);
  if (!order || order.state !== 'funded') return;
  if (req.pubkey !== order.sponsorPubkey) {
    return console.warn('[Onchain] 후원자가 아닌 쪽의 사전서명', req.orderId);
  }

  const meta = getEscrowMeta(req.orderId);
  const descriptor = escrowDescriptorFor(order);
  const outpoint = parseOutpoint(order.fundingOutpoint);
  if (!meta?.payoutAddress || !descriptor || !outpoint || order.releaseFeeSat === undefined) {
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
    expected: {
      descriptor,
      input: { outpoint, valueSat: order.amountSat },
      path: 'release',
      destination: meta.payoutAddress,
      feeSat: order.releaseFeeSat,
    },
    signerXonly: order.sponsorXonly!,
  });
  if (!verdict.ok) {
    return console.warn('[Onchain] 사전서명 거부:', req.orderId, verdict.reason);
  }

  mergeEscrowMeta(req.orderId, { presigPsbt: payload.psbt });

  const at = now();
  const updated = await commitOnchainOrder(req.orderId, { state: 'presigned', presignedAt: at });
  if (!updated) return;

  // 고객이 나중에 릴리스에 서명할 수 있도록 **지금** 보낸다 — 그때 고객이 온라인이면 바로 끝난다.
  //
  // ⚠️ 실패해도 상태는 되돌리지 않는다(사전서명은 유효하다). 다만 **고객이 이
  // PSBT를 못 받으면 릴리스를 완성할 수 없다** — 안에 후원자 서명이 들어 있다.
  // 재전송 경로는 어드민 화면에서 눌러야 한다(P5).
  try {
    await publishOnchainSignRequest(
      req.orderId, order.customerPubkey, 'release', payload.psbt, order.expiration,
    );
  } catch (e) {
    console.error('[Onchain] 릴리스 PSBT 전달 실패 — 재전송이 필요하다', req.orderId, e);
  }
  console.log('[Onchain] 사전서명 검증 완료', req.orderId);
}

// ─── ⑤ 최종 서명 → 브로드캐스트 ──────────────────────────────

export async function handleOnchainCosign(req: OnchainCosignMsg): Promise<void> {
  if (!chain) return;
  const order = getOnchainOrder(req.orderId);
  if (!order) return;

  const expected = expectedSettlement(order, req.purpose);
  if (!expected) {
    return console.warn('[Onchain] 이 서명을 붙일 tx가 없다', req.orderId, req.purpose);
  }

  const signerIsSponsor = req.purpose === 'dispute-sponsor';
  const expectedSender = signerIsSponsor ? order.sponsorPubkey : order.customerPubkey;
  const signerXonly = signerIsSponsor ? order.sponsorXonly : order.customerXonly;
  if (req.pubkey !== expectedSender || !signerXonly) {
    return console.warn('[Onchain] 서명자가 맞지 않는다', req.orderId, req.purpose);
  }

  let payload: unknown;
  try {
    payload = await decryptFrom(req.pubkey, contentOf(req));
  } catch (e) {
    return console.warn('[Onchain] 최종 서명 암호문을 못 열었다', req.orderId, e);
  }
  if (!isOnchainPsbtPayload(payload)) return;

  const verdict = verifyPresignature({
    psbtBase64: payload.psbt,
    expected: expected.params,
    signerXonly,
  });
  if (!verdict.ok) {
    return console.warn('[Onchain] 최종 서명 거부:', req.orderId, verdict.reason);
  }

  // 완성 → 브로드캐스트. 여기서부터는 되돌아가지 않는다(O-005).
  let rawHex: string;
  try {
    const tx = fromPsbtBase64(payload.psbt);
    finalizeSettlement(tx, expected.params.path);
    rawHex = tx.hex;
  } catch (e) {
    return console.warn('[Onchain] 종결 tx를 완성하지 못했다', req.orderId, e);
  }

  const sent = await chain.broadcastTx(rawHex);
  if (!sent.known) {
    return console.warn('[Onchain] 브로드캐스트 실패 — 다시 시도한다:', req.orderId, sent.reason);
  }

  if (!canOnchainTransition(order.state, 'settling')) {
    return console.error('[Onchain] 브로드캐스트는 됐는데 전이가 막혔다', req.orderId, order.state);
  }

  await commitOnchainOrder(req.orderId, {
    state: 'settling',
    settlementKind: expected.kind,
    settlementTxid: sent.value,
    settlingAt: now(),
  });
  deletePendingSettlement(req.orderId);
  console.log('[Onchain] 종결 브로드캐스트', req.orderId, expected.kind, sent.value);
}

interface ExpectedSettlement {
  kind: SettlementKind;
  params: Parameters<typeof buildSettlementTx>[0];
}

/**
 * 이 purpose가 가리키는 tx를 **우리 기록으로** 재구성한다.
 *
 * 릴리스만 대기 레코드 없이 온다 — 후원자 사전서명 + 고객 서명이면 완성이라
 * 어드민이 서명할 게 없다(O-007: 우리가 대신 만들지 않는다).
 */
function expectedSettlement(
  order: OnchainOrder,
  purpose: OnchainCosignMsg['purpose'],
): ExpectedSettlement | null {
  const descriptor = escrowDescriptorFor(order);
  const outpoint = parseOutpoint(order.fundingOutpoint);
  if (!descriptor || !outpoint) return null;

  if (purpose === 'release') {
    const meta = getEscrowMeta(order.orderId);
    if (!meta?.payoutAddress || order.releaseFeeSat === undefined) return null;
    return {
      kind: 'release',
      params: {
        descriptor,
        input: { outpoint, valueSat: order.amountSat },
        path: 'release',
        destination: meta.payoutAddress,
        feeSat: order.releaseFeeSat,
      },
    };
  }

  const pending = getPendingSettlement(order.orderId);
  if (!pending) return null;
  return {
    kind: pending.settlementKind,
    params: {
      descriptor,
      input: { outpoint, valueSat: order.amountSat },
      path: pending.path,
      destination: pending.destination,
      feeSat: pending.feeSat,
    },
  };
}

// ─── ⑤b 원화 송금 주장 ───────────────────────────────────────

/**
 * 후원자가 "원화 보냈다" → `presigned → remitted`.
 *
 * ⚠️ 액션은 라이트닝의 `remit-request`를 **그대로 쓴다.** §5.2의 새 액션
 * 목록에 이게 빠져 있었는데(P4에서 발견), 뜻과 모양이 완전히 같아 새로 만들
 * 이유가 없다. 트랙은 `t` 태그로 갈린다.
 *
 * ⚠️ **이건 후원자의 일방적 주장이다**(O-007). 여기서 릴리스가 나가지 않는다 —
 * 고객이 은행을 확인하고 서명해야만 BTC가 움직인다.
 */
export async function handleOnchainRemit(req: { orderId: string; pubkey: string }): Promise<void> {
  const order = getOnchainOrder(req.orderId);
  if (!order || order.state !== 'presigned') return;
  if (req.pubkey !== order.sponsorPubkey) {
    return console.warn('[Onchain] 후원자가 아닌 쪽의 송금 주장', req.orderId);
  }
  // 계좌가 나가기 전에 "보냈다"는 성립할 수 없다.
  if (!order.accountSentAt) {
    return console.warn('[Onchain] 계좌가 아직 안 나갔다', req.orderId);
  }

  await commitOnchainOrder(req.orderId, { state: 'remitted', remittedAt: now() });
}

// ─── ⑥ 분쟁 ──────────────────────────────────────────────────

export async function handleOnchainDispute(req: OnchainDisputeMsg): Promise<void> {
  const order = getOnchainOrder(req.orderId);
  if (!order) return;
  if (req.pubkey !== order.customerPubkey && req.pubkey !== order.sponsorPubkey) return;

  if (order.state === 'remitted') {
    await commitOnchainOrder(req.orderId, { state: 'disputed' });
    return;
  }

  // ⚠️ **계좌 이의는 상태가 아니다** (§5.2b). 상태로 받으면 원화 마감 시계가
  // 멈추고 그 순간 무한 옵션이 열린다(§7.6 R4-H1). 마감은 그대로 흐르고,
  // 이 주장은 **보증금을 몰수할지 환불할지만** 가른다 — 판정은 사람이 한다.
  if (order.state === 'presigned' && req.stage === 'account-unusable') {
    console.warn('[Onchain] 계좌 이의 접수 (시계는 계속 간다):', req.orderId, req.pubkey.slice(0, 8));
    return;
  }

  console.warn('[Onchain] 이 상태에서는 분쟁을 열 수 없다:', req.orderId, order.state);
}

// ─── ⑦ 종결 준비 (워처가 부른다) ─────────────────────────────

/**
 * 마감이 찬 주문의 종결 tx를 만들어 **어드민 서명까지** 얹어두고, 상대에게
 * 서명을 요청한다. 상태는 아직 안 바뀐다 — 체인에 아무 일도 안 일어났다.
 */
export async function prepareOnchainSettlement(
  order: OnchainOrder,
  kind: SettlementKind,
): Promise<void> {
  if (!chain) return;
  if (getPendingSettlement(order.orderId)) return;

  const descriptor = escrowDescriptorFor(order);
  const outpoint = parseOutpoint(order.fundingOutpoint);
  if (!descriptor || !outpoint) {
    return console.error('[Onchain] 종결 tx 재료가 없다', order.orderId);
  }

  const { path, destination, awaiting } = settlementShape(order, kind);
  if (!destination) return console.error('[Onchain] 받을 주소가 없다', order.orderId, kind);

  // ⚠️ **수수료를 새로 추정한다.** `releaseFeeSat`은 T0에 고정된 값이라
  // 분쟁이 몇 주 뒤에 끝나면 낡는다 — 그대로 쓰면 tx가 멤풀에서 썩는다(§6.1).
  const fees = await chain.getFeeEstimates();
  if (!fees.known) return console.warn('[Onchain] 수수료를 몰라 종결을 미룬다', order.orderId);

  let psbt: string;
  let feeSat: number;
  try {
    feeSat = settlementFeeSat(path, descriptor, destination, fees.value.halfHour);
    const tx = buildSettlementTx({
      descriptor,
      input: { outpoint, valueSat: order.amountSat },
      path,
      destination,
      feeSat,
    });
    const adminKey = await getOrderKey(order.orderId);
    if (!adminKey) {
      return console.error('[Onchain] 어드민 키가 없다 — 중재 불가', order.orderId);
    }
    signSettlement(tx, adminKey.privkey);
    psbt = toPsbtBase64(tx);
  } catch (e) {
    return console.error('[Onchain] 종결 tx를 만들지 못했다', order.orderId, e);
  }

  putPendingSettlement({
    orderId: order.orderId,
    settlementKind: kind,
    path,
    psbt,
    destination,
    feeSat,
    awaiting,
    createdAt: now(),
    lastRequestedAt: now(),
  });

  const recipient = awaiting === 'customer' ? order.customerPubkey : order.sponsorPubkey;
  if (recipient) {
    try {
      await publishOnchainSignRequest(
        order.orderId, recipient,
        awaiting === 'customer' ? (kind === 'customer_win' ? 'dispute-customer' : 'refund') : 'dispute-sponsor',
        psbt, order.expiration,
      );
    } catch (e) {
      // 대기 레코드는 남는다 — 재촉은 워처가 `lastRequestedAt`을 보고 다시 보낸다.
      console.error('[Onchain] 종결 서명 요청 전달 실패', order.orderId, e);
    }
  }
  console.log('[Onchain] 종결 준비', order.orderId, kind, '→', awaiting);
}

/** 사유 → (리프, 받는 쪽, 서명해야 할 사람) */
function settlementShape(order: OnchainOrder, kind: SettlementKind): {
  path: SettlementPath;
  destination: string | undefined;
  awaiting: 'customer' | 'sponsor';
} {
  if (kind === 'sponsor_win') {
    return {
      path: 'sponsor-win',
      destination: getEscrowMeta(order.orderId)?.payoutAddress,
      awaiting: 'sponsor',
    };
  }
  if (kind === 'release') {
    return {
      path: 'release',
      destination: getEscrowMeta(order.orderId)?.payoutAddress,
      awaiting: 'customer',
    };
  }
  // 환불·고객승 — **고객에게 물어보지 않는다.** 환불이 발동하는 순간이 바로
  // 고객이 응답하지 않는 순간이라, 주문별 키로 결정론적 주소를 만든다.
  return {
    path: kind === 'customer_win' ? 'customer-win' : 'refund',
    destination: order.customerXonly
      ? deriveSingleKeyAddress(order.customerXonly, order.network)
      : undefined,
    awaiting: 'customer',
  };
}

// ─── ⑧ 계좌 정보 게이트 ──────────────────────────────────────

/** 고객이 계좌를 공개해도 되는 상태인지 + 그 시점을 기록한다 (O-002·O-003·O-013) */
export async function noteAccountInfoSent(orderId: string): Promise<void> {
  const order = getOnchainOrder(orderId);
  if (!order || !canSendAccountInfoOnchain(order.state)) return;
  if (order.accountSentAt) return;

  const at = now();
  const updated = await commitOnchainOrder(orderId, {
    accountSentAt: at,
    // ⚠️ 후원자 마감은 **여기서부터** 센다. 고객 지연이 후원자 창을 깎지 않는다.
    krwDeadline: krwDeadlineFrom(at),
  });
  // 상태가 안 바뀌므로 전이 알림이 안 뜬다. 후원자가 움직일 수 있게 되는
  // 순간이 정확히 여기라 따로 보낸다.
  if (updated) notifyOnchainAccountArrived(updated);
}

/** 워처가 쓰는 "계좌가 나갔는가" */
export function accountInfoSent(orderId: string): boolean {
  return Boolean(getOnchainOrder(orderId)?.accountSentAt);
}

/** 워처가 도는 대상 */
export function listOnchainOrders(): OnchainOrder[] {
  return Object.values(getSnapshot());
}

/** 어드민 pubkey로 오는 요청인지 (구독 필터 보조) */
export function isForAdmin(tags: string[][]): boolean {
  return tags.some(t => t[0] === 'p' && t[1] === APP_PUBKEY);
}
