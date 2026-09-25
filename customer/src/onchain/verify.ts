/**
 * 내가 직접 확인하는 것들 (PLAN-ONCHAIN-TRACK §3.4 · §7 G·I)
 *
 * **어드민이 알려준 값을 그냥 믿지 않는다.** 어드민이 악의적이거나 침해당했을 때
 * 전액을 잃는 자리라, 클라이언트가 자기 키로 **다시 만들어 대조**한다.
 * 이건 타협 대상이 아니다.
 */
import {
  MAX_SANE_SETTLEMENT_FEERATE, assertEscrowKeys, buildSettlementTx, deriveEscrowAddress,
  deriveSingleKeyAddress, estimateSettlementVsize, fromPsbtBase64, outputAddressOf,
  parseOutpoint, requiredConfirmations, verifyEscrowAddress, verifyPresignature,
  type AddressFunds, type BuildSettlementParams, type ChainQuery, type EscrowDescriptor,
  type OnchainOrder, type SettlementPath, type SignPurpose,
} from '@sajwo-tracker/shared/onchain';

export type EscrowCheck =
  | { ok: true; descriptor: EscrowDescriptor }
  | { ok: false; reason: string; derived?: string };

/**
 * 이 오더의 에스크로 주소가 **내 키로 만든 그 주소**인지.
 *
 * `myXonly`를 인자로 받아, 오더에 실린 내 x-only가 **진짜 내 것인지**부터 본다 —
 * 어드민이 내 키 자리에 남의 키를 꽂아두면 나는 그 돈을 영영 못 만진다.
 */
export function checkEscrowAddress(
  order: OnchainOrder,
  role: 'customer' | 'sponsor',
  myXonly: string,
): EscrowCheck {
  const { customerXonly, sponsorXonly, adminXonly, escrowAddress } = order;
  if (!customerXonly || !sponsorXonly || !adminXonly || !escrowAddress) {
    return { ok: false, reason: '아직 에스크로 정보가 오지 않았다' };
  }

  const mine = role === 'customer' ? customerXonly : sponsorXonly;
  if (mine !== myXonly) {
    return { ok: false, reason: '오더에 실린 내 키가 내가 파생한 키와 다르다' };
  }

  try {
    assertEscrowKeys({ customer: customerXonly, sponsor: sponsorXonly, admin: adminXonly });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  return verifyEscrowAddress(
    {
      keys: { customer: customerXonly, sponsor: sponsorXonly, admin: adminXonly },
      network: order.network,
      timelockBlocks: order.timelockBlocks,
    },
    escrowAddress,
  ) as EscrowCheck;
}

/**
 * 서명해도 되는 요청인지의 판정.
 *
 * 통과하면 **내가 서명할 tx의 재료**(`expected`)를 돌려준다. 서명은 받은 PSBT가 아니라
 * 이 재료로 **다시 만든 tx**에 한다 — 받은 PSBT에 그대로 서명하면 그 안에 무슨 리프·
 * 무슨 주소가 들었는지를 보낸 쪽 말만 믿는 셈이다.
 */
export type SignCheck =
  | {
      ok: true;
      expected: BuildSettlementParams;
      /** 받는 주소 (화면에 보여준다) */
      destination: string;
      /** 나가는 금액 / 수수료 (sat) */
      amountSat: number;
      feeSat: number;
      /** 릴리스일 때 — 검증을 통과한 후원자 사전서명 (내 tx에 옮겨 심는다) */
      counterparty?: { xonly: string; sig: Uint8Array; leafScript: Uint8Array };
    }
  | {
      ok: false;
      reason: string;
      /** 환불 주소를 이 기기가 몰라서 대조하지 못했다 — 유저가 다시 입력하면 된다 */
      needsRefundAddress?: boolean;
    };

export interface SignCheckInput {
  order: OnchainOrder;
  purpose: SignPurpose;
  psbt: string;
  role: 'customer' | 'sponsor';
  myXonly: string;
  /** 고객 — 의뢰 때 낸 환불 주소(이 기기 기록이나 유저가 다시 입력한 것) */
  refundAddress?: string;
  /** 후원자 — 클레임 때 낸 받을 주소 */
  payoutAddress?: string;
}

/**
 * 요청을 **내 기록으로 다시 만들어** 대조한다 (리뷰 #8).
 *
 * 전에는 "내 에스크로 UTXO를 쓰는가" 하나만 봤다. 악의적이거나 침해된 어드민이
 * `{A,C}` 리프로 **자기 주소에 보내는 "환불"**을 보내면 화면이 "내 에스크로가 맞다"고
 * 말했고, 고객 서명 하나로 어드민이 2-of-2를 완성했다. §3.4("어드민이 침해당해도 전액을
 * 잃지 않는다")가 서명 단계에서 새고 있었다.
 *
 * 목적별로 **누구에게 얼마가 가야 하는지**를 내가 정하고, 받은 PSBT가 그 tx와
 * 바이트까지 같은지(txid) 본다. 수수료도 본다 — 주소가 맞아도 채굴자에게 태울 수 있다.
 */
export function checkSignRequest(input: SignCheckInput): SignCheck {
  const { order, purpose, psbt, role, myXonly } = input;

  const escrow = checkEscrowAddress(order, role, myXonly);
  if (!escrow.ok) return { ok: false, reason: escrow.reason };
  const descriptor = escrow.descriptor;

  let theirs;
  try {
    theirs = fromPsbtBase64(psbt);
  } catch (e) {
    return { ok: false, reason: `PSBT를 읽지 못했다: ${e instanceof Error ? e.message : e}` };
  }
  if (theirs.inputsLength !== 1 || theirs.outputsLength !== 1) {
    return { ok: false, reason: '입력 1개·출력 1개가 아니다' };
  }
  const shown = outputAddressOf(theirs, descriptor);
  if (!shown) return { ok: false, reason: '받는 주소를 읽지 못했다' };

  // ── 목적별로 "어디로·어느 리프·어느 입력"을 내가 정한다 ──
  let path: SettlementPath;
  let destination: string;
  let input0: BuildSettlementParams['input'];
  let feeSat: number;

  if (purpose === 'rescue') {
    // 구조는 약정 밖의 UTXO다 — 입력을 PSBT에서 읽되 **그게 내 에스크로의 출력인지** 본다.
    const inp = theirs.getInput(0);
    const script = inp?.witnessUtxo?.script;
    if (!inp?.txid || inp.index === undefined || !script || inp.witnessUtxo?.amount === undefined) {
      return { ok: false, reason: '구조 PSBT에 입력 정보가 없다' };
    }
    if (hex(script) !== hex(descriptor.payment.script)) {
      return { ok: false, reason: '내 에스크로 주소의 자금이 아니다' };
    }
    input0 = { outpoint: { txid: hex(inp.txid), vout: inp.index }, valueSat: Number(inp.witnessUtxo.amount) };
    const out = Number(theirs.getOutput(0)?.amount ?? 0n);
    feeSat = input0.valueSat - out;
    path = 'refund';
    const dest = refundDestination(order, myXonly, input.refundAddress, shown);
    if (!dest.ok) return dest;
    destination = dest.address;
  } else {
    const outpoint = parseOutpoint(order.fundingOutpoint);
    if (!outpoint) return { ok: false, reason: '이 주문에 입금 기록이 없다' };
    input0 = { outpoint, valueSat: order.amountSat };

    if (purpose === 'release') {
      if (role !== 'customer') return { ok: false, reason: '지급 서명은 파는 쪽이 한다' };
      if (order.releaseFeeSat === undefined) return { ok: false, reason: '릴리스 수수료가 없다' };
      // 후원자 주소는 내가 모른다 — 대신 **후원자 서명이 이 tx에 대해 유효한지**로 묶는다.
      path = 'release';
      destination = shown;
      feeSat = order.releaseFeeSat;
    } else if (purpose === 'dispute-sponsor') {
      if (role !== 'sponsor') return { ok: false, reason: '송금 인정 판정의 집행은 사는 쪽이 서명한다' };
      if (order.settlementKind !== 'sponsor_win') return { ok: false, reason: '송금 인정 판정이 없다' };
      if (!input.payoutAddress) return { ok: false, reason: '클레임 때 낸 받을 주소를 이 기기가 모른다' };
      if (shown !== input.payoutAddress) return { ok: false, reason: '받는 주소가 내가 낸 받을 주소가 아니다' };
      path = 'sponsor-win';
      destination = input.payoutAddress;
      if (order.settlementFeeSat === undefined) return { ok: false, reason: '결정된 수수료가 없다' };
      feeSat = order.settlementFeeSat;
    } else {
      // refund · dispute-customer — 둘 다 `{A,C}`로 **내게** 돌아오는 tx다
      if (role !== 'customer') return { ok: false, reason: '환불은 파는 쪽이 서명한다' };
      const wantKind = purpose === 'refund' ? order.state === 'refunding' : order.settlementKind === 'customer_win';
      if (!wantKind) return { ok: false, reason: '이 서명에 해당하는 결정이 없다' };
      if (order.settlementFeeSat === undefined) return { ok: false, reason: '결정된 수수료가 없다' };
      path = purpose === 'refund' ? 'refund' : 'customer-win';
      const dest = refundDestination(order, myXonly, input.refundAddress, shown);
      if (!dest.ok) return dest;
      destination = dest.address;
      feeSat = order.settlementFeeSat;
    }
  }

  const expected: BuildSettlementParams = { descriptor, input: input0, path, destination, feeSat };

  // 수수료 — 주소가 맞아도 채굴자에게 태우는 건 막아야 한다.
  let vsize: number;
  try {
    vsize = estimateSettlementVsize(path, descriptor, destination);
  } catch (e) {
    return { ok: false, reason: `받는 주소를 쓸 수 없다: ${e instanceof Error ? e.message : e}` };
  }
  if (feeSat < 0 || feeSat / vsize > MAX_SANE_SETTLEMENT_FEERATE) {
    return { ok: false, reason: `수수료가 비정상이다: ${feeSat.toLocaleString()} sats` };
  }

  // 받은 PSBT가 **내가 만든 tx와 바이트까지 같은지** (서명은 증인이라 txid에 안 들어간다)
  let mineId: string;
  try {
    mineId = buildSettlementTx(expected).id;
  } catch (e) {
    return { ok: false, reason: `기대 tx를 만들지 못했다: ${e instanceof Error ? e.message : e}` };
  }
  if (theirs.id !== mineId) {
    return { ok: false, reason: '요청받은 tx가 내가 기대한 tx와 다르다 (금액·주소·수수료 중 무엇인가 다르다)' };
  }

  const amountSat = input0.valueSat - feeSat;
  let counterparty: { xonly: string; sig: Uint8Array; leafScript: Uint8Array } | undefined;
  if (purpose === 'release') {
    if (order.payoutSat !== undefined && amountSat !== order.payoutSat) {
      return { ok: false, reason: '릴리스 금액이 오더의 지급액과 다르다' };
    }
    const sponsor = verifyPresignature({ psbtBase64: psbt, expected, signerXonly: order.sponsorXonly! });
    if (!sponsor.ok) return { ok: false, reason: `상대방 서명이 맞지 않는다: ${sponsor.reason}` };
    counterparty = { xonly: order.sponsorXonly!, sig: sponsor.sig, leafScript: sponsor.leafScript };
  }

  return { ok: true, expected, destination, amountSat, feeSat, counterparty };
}

/**
 * 환불이 가야 하는 곳 — **내가 낸 환불 주소**, 또는 (그 전에 만든 주문이면) 내 주문별
 * 키로 만든 단일키 주소. 둘 다 아니면 서명하지 않는다.
 */
function refundDestination(
  order: OnchainOrder,
  myXonly: string,
  refundAddress: string | undefined,
  shown: string,
): { ok: true; address: string } | { ok: false; reason: string; needsRefundAddress?: boolean } {
  const derived = deriveSingleKeyAddress(myXonly, order.network);
  if (shown === derived) return { ok: true, address: derived };
  if (refundAddress && shown === refundAddress.trim()) return { ok: true, address: shown };
  if (!refundAddress) {
    return {
      ok: false,
      reason: '이 기기는 내가 낸 환불 주소를 모른다 — 주소를 입력하면 대조한다',
      needsRefundAddress: true,
    };
  }
  return { ok: false, reason: '받는 주소가 내 환불 주소가 아니다 — 서명하지 마세요' };
}

/**
 * 원화를 보내기 전에 **펀딩이 실제로 체인에 있는지** 스스로 본다 (후원자).
 *
 * 전에는 펀딩 tx의 컨펌 수만 봤다. 그 출력이 정말 **이 에스크로 주소로 약정 금액을**
 * 보내는지는 안 봐서, 어드민이 엉뚱한 outpoint를 `funded`로 발행해도(버그든 악의든)
 * 후원자는 빈 에스크로에 원화를 보냈다(리뷰 #8).
 */
export function checkFundingOnChain(
  order: OnchainOrder,
  funds: ChainQuery<AddressFunds> | undefined,
): { ok: true; confirmations: number } | { ok: false; reason: string } {
  const outpoint = parseOutpoint(order.fundingOutpoint);
  if (!outpoint) return { ok: false, reason: '입금 기록이 없다' };
  if (!funds) return { ok: false, reason: '체인을 확인하는 중' };
  if (!funds.known) return { ok: false, reason: `체인 조회 실패: ${funds.reason}` };
  const utxo = funds.value.confirmed.find(u => u.txid === outpoint.txid && u.vout === outpoint.vout);
  if (!utxo) return { ok: false, reason: '에스크로 주소에 그 입금이 없다 — 송금하지 마세요' };
  if (utxo.valueSat !== order.amountSat) {
    return { ok: false, reason: `에스크로 금액이 약정과 다르다 (${utxo.valueSat} sats) — 송금하지 마세요` };
  }
  const required = requiredConfirmations(order.amountSat);
  if (utxo.confirmations < required) {
    return { ok: false, reason: `컨펌이 모자라다 (${utxo.confirmations}/${required})` };
  }
  return { ok: true, confirmations: utxo.confirmations };
}

/**
 * 릴리스에 서명해도 되는가 — **가격 유효창**을 확인한다 (O-016).
 *
 * 후원자가 늦게 원화를 보내 **낡은 가격으로 체결**시키는 걸 막는 마지막 방어선이다.
 * 앱 규칙은 직접 브로드캐스트를 못 막으므로, 손해를 보는 당사자 자신이 막는다.
 */
export function releaseNeedsPriceOverride(order: OnchainOrder, nowMs: number): boolean {
  if (!order.remittedAt) return false;
  return nowMs - order.remittedAt * 1000 > 24 * 60 * 60 * 1000;
}

/** 에스크로 검증 결과를 화면 문구로 */
export function escrowCheckMessage(check: EscrowCheck): string {
  if (check.ok) return '주소를 확인했습니다. 이 주소는 내 키로 만들어진 것이 맞습니다.';
  return check.derived
    ? `⚠️ 주소가 일치하지 않습니다. 절대 보내지 마세요. (내가 만든 주소: ${check.derived})`
    : `⚠️ ${check.reason}`;
}

/** 에스크로 파생 (펀딩 확인 등에 쓴다) */
export function escrowOf(order: OnchainOrder): EscrowDescriptor | null {
  if (!order.customerXonly || !order.sponsorXonly || !order.adminXonly) return null;
  try {
    return deriveEscrowAddress({
      keys: { customer: order.customerXonly, sponsor: order.sponsorXonly, admin: order.adminXonly },
      network: order.network,
      timelockBlocks: order.timelockBlocks,
    });
  } catch {
    return null;
  }
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
