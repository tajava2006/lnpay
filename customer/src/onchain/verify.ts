/**
 * 내가 직접 확인하는 것들 (PLAN-ONCHAIN-TRACK §3.4 · §7 G·I)
 *
 * **어드민이 알려준 값을 그냥 믿지 않는다.** 어드민이 악의적이거나 침해당했을 때
 * 전액을 잃는 자리라, 클라이언트가 자기 키로 **다시 만들어 대조**한다.
 * 이건 타협 대상이 아니다.
 */
import {
  assertEscrowKeys, fromPsbtBase64, parseOutpoint, verifyEscrowAddress,
  type EscrowDescriptor, type OnchainOrder,
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

export type PsbtCheck =
  | { ok: true; amountSat: number; destination: string }
  | { ok: false; reason: string };

/**
 * 서명해 달라고 온 PSBT가 **이 주문의 에스크로를 쓰는지**, 그리고 얼마가
 * 어디로 가는지 (§7 I).
 *
 * 받는 주소가 누구 것인지는 **내가 알 수 없다** — 후원자가 자기 지갑 주소를
 * 낸 것이고, 그건 후원자의 자유다. 내가 확인할 수 있는 건
 *   ① 내 에스크로 UTXO를 쓰는가 ② 출력이 하나인가 ③ 금액이 내가 아는 값인가
 * 셋뿐이고, 그 셋이면 "내가 잃는 금액"은 확정된다.
 */
export function inspectSettlementPsbt(
  order: OnchainOrder,
  psbtBase64: string,
): PsbtCheck {
  const outpoint = parseOutpoint(order.fundingOutpoint);
  if (!outpoint) return { ok: false, reason: '이 주문에 펀딩 기록이 없다' };

  let tx;
  try {
    tx = fromPsbtBase64(psbtBase64);
  } catch (e) {
    return { ok: false, reason: `PSBT를 읽지 못했다: ${e instanceof Error ? e.message : e}` };
  }

  if (tx.inputsLength !== 1 || tx.outputsLength !== 1) {
    return { ok: false, reason: '입력 1개·출력 1개가 아니다' };
  }

  const input = tx.getInput(0);
  const txid = input?.txid ? bytesToHexLocal(input.txid) : '';
  if (txid !== outpoint.txid || input?.index !== outpoint.vout) {
    return { ok: false, reason: '내 에스크로가 아닌 UTXO를 쓰려 한다' };
  }

  const out = tx.getOutput(0);
  const amountSat = Number(out?.amount ?? 0n);
  if (!Number.isSafeInteger(amountSat) || amountSat <= 0) {
    return { ok: false, reason: '출력 금액이 이상하다' };
  }

  return { ok: true, amountSat, destination: out?.script ? bytesToHexLocal(out.script) : '' };
}

function bytesToHexLocal(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
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
