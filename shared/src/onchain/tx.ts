/**
 * 종결 tx 빌더 (PLAN-ONCHAIN-TRACK §6.1 · §7 I·J·L·O)
 *
 * 에스크로 UTXO 하나를 먹고 출력 하나를 내는 tx만 만든다. 네 경로 전부 모양이
 * 같고 **어느 리프로 소모하느냐**와 **누구에게 보내느냐**만 다르다.
 *
 * | 경로 | 리프 | 받는 쪽 | 서명자 |
 * |---|---|---|---|
 * | `release` | leaf 1 | 후원자 | 고객 + 후원자 |
 * | `refund` · `customer-win` | leaf 2 | 고객 | 어드민 + 고객 |
 * | `sponsor-win` | leaf 3 | 후원자 | 어드민 + 후원자 |
 * | `timelock` | leaf 4 | 고객 | 고객 단독 (CSV 경과 후) |
 *
 * `refund`와 `customer-win`은 **tx가 완전히 같다.** 다른 건 사유와 보증금 처리뿐이라
 * (§4.1) 여기서는 한 모양으로 만들고, 장부에서만 가른다.
 *
 * ── 어드민 출력을 달지 않는다
 *
 * 중재료는 **몰수된 보증금에서** 충당한다(§4.1, Q4). 분쟁 tx에 어드민 출력을
 * 달면 승자가 받을 금액이 깎이고 tx도 커진다. 그래서 어느 경로든 **출력은 하나**다.
 *
 * ── RBF를 끈다 (§7 O)
 *
 * 모든 입력의 nSequence를 final(`0xffffffff`)로 둔다. 릴리스가 멤풀에 있는 동안
 * 고객이 같은 UTXO를 쓰는 다른 tx로 교체하면 **릴리스를 탈취**할 수 있기 때문이다.
 * 환불·분쟁도 같게 둔다 — 어차피 교체하려면 상대 서명이 다시 필요해서 RBF로
 * 얻는 게 없고, 경로마다 다르게 두면 그 자체가 버그 자리다.
 * 막히면 **받는 쪽이 CPFP** 한다(§7 L).
 *
 * 예외는 `timelock`뿐이다 — CSV를 만족시키려면 nSequence가 **블록 수 그 자체**여야 한다.
 */
import { Address, OutScript, TaprootControlBlock, Transaction } from '@scure/btc-signer';
import { bytesToHex } from './hex';
import type { EscrowDescriptor } from './address';
import { networkParamsFor } from './address';
import type { EscrowLeafName } from './script';

export interface Outpoint {
  txid: string;
  vout: number;
}

export type SettlementPath = 'release' | 'refund' | 'customer-win' | 'sponsor-win' | 'timelock';

/** BIP-68 상대 타임락은 **tx version 2 이상**에서만 동작한다. */
const TX_VERSION = 2;

/** RBF 비활성 (§7 O) */
const SEQUENCE_FINAL = 0xffffffff;

/**
 * 출력 종류별 dust 한계(sat). 이보다 작으면 릴레이가 안 받아준다.
 *
 * 모르는 종류는 **가장 큰 값**으로 잡는다 — 모자라게 잡으면 tx가 멤풀에서
 * 조용히 거절되고, 그건 "왜 안 잡히지"로 한참 헤매는 종류의 버그다.
 */
const DUST_BY_TYPE: Record<string, number> = {
  tr: 330, wsh: 330, tr_ns: 330, tr_ms: 330,
  wpkh: 294,
  pkh: 546, sh: 540,
};
const DUST_FALLBACK = 546;

export function settlementLeafFor(path: SettlementPath): EscrowLeafName {
  switch (path) {
    case 'release': return 'release';
    case 'refund':
    case 'customer-win': return 'customer-win';
    case 'sponsor-win': return 'sponsor-win';
    case 'timelock': return 'timelock';
  }
}

/** 주소 → scriptPubKey. 네트워크가 다르면 여기서 던진다(디코딩이 실패한다). */
export function outputScriptFor(address: string, descriptor: EscrowDescriptor): Uint8Array {
  const decoded = Address(networkParamsFor(descriptor.network)).decode(address);
  return OutScript.encode(decoded);
}

export function dustThresholdFor(address: string, descriptor: EscrowDescriptor): number {
  const decoded = Address(networkParamsFor(descriptor.network)).decode(address);
  return DUST_BY_TYPE[decoded.type] ?? DUST_FALLBACK;
}

/**
 * 종결 tx의 vsize 추정.
 *
 * 리프마다 증인 크기가 다르고(2서명 vs 1서명), **받는 주소 종류마다 출력 크기가
 * 다르다** — 후원자가 어떤 주소를 낼지 우리가 정하지 않으므로 실제 스크립트에서 센다.
 *
 * 값은 **정확하다**(추정이 아니라 계산이다). Schnorr 서명은 SIGHASH_DEFAULT에서
 * 길이가 64로 고정이고 나머지는 전부 고정 길이다.
 */
export function estimateSettlementVsize(
  path: SettlementPath,
  descriptor: EscrowDescriptor,
  destination: string,
): number {
  const leafName = settlementLeafFor(path);
  const leaf = descriptor.leaves.find(l => l.name === leafName);
  if (!leaf) throw new Error(`알 수 없는 리프: ${leafName}`);

  const spkLen = outputScriptFor(destination, descriptor).length;

  // 비증인: version(4) + 입력수(1) + 입력(36+1+4) + 출력수(1) + 출력(8+1+spk) + locktime(4)
  const nonWitness = 4 + 1 + 41 + 1 + (9 + spkLen) + 4;

  // 증인: 스택 개수(1) + 서명들(1+64) + 스크립트(1+len) + control block(1+97)
  const sigs = leaf.signers.length;
  const witness = 1 + sigs * 65 + (1 + leaf.script.length) + 98;

  // segwit marker + flag는 증인 쪽 2 weight unit
  const weight = nonWitness * 4 + witness + 2;
  return Math.ceil(weight / 4);
}

/** feerate(sat/vB) → 이 tx의 수수료(sat) */
export function settlementFeeSat(
  path: SettlementPath,
  descriptor: EscrowDescriptor,
  destination: string,
  feerateSatPerVb: number,
): number {
  if (!Number.isFinite(feerateSatPerVb) || feerateSatPerVb <= 0) {
    throw new Error(`feerate가 비정상이다: ${feerateSatPerVb}`);
  }
  return Math.ceil(estimateSettlementVsize(path, descriptor, destination) * feerateSatPerVb);
}

/**
 * 에스크로가 아직 없을 때 쓰는 **표준 종결 tx 크기**(vB).
 *
 * 2서명 리프 + P2TR 출력 기준이다. 보증금 하한을 잡으려면 주소가 생기기
 * **전에** 종결 수수료를 알아야 해서 필요하다(§6.0). 실제 tx를 만들 때는
 * 언제나 `estimateSettlementVsize()`로 다시 센다.
 */
export const TYPICAL_SETTLEMENT_VSIZE = 169;

export interface BuildSettlementParams {
  descriptor: EscrowDescriptor;
  /** 에스크로 UTXO — `funded`에서 박아둔 것 */
  input: { outpoint: Outpoint; valueSat: number };
  path: SettlementPath;
  /** 받을 주소 */
  destination: string;
  /** 이 tx가 낼 수수료(sat). 출력 = 입력 − 이 값 */
  feeSat: number;
}

/**
 * 서명 전 tx를 만든다. **어느 쪽이 만들어도 같은 바이트**가 나와야 한다 —
 * 그래야 사전서명을 검증할 때 "내가 만든 것과 같은가"로 대조할 수 있다(§7 I).
 *
 * 그래서 임의성이 들어갈 자리를 전부 없앴다: version 고정, locktime 0,
 * 입력 하나, 출력 하나, nSequence 규칙 고정.
 */
export function buildSettlementTx(params: BuildSettlementParams): Transaction {
  const { descriptor, input, path, destination, feeSat } = params;

  if (!Number.isInteger(input.valueSat) || input.valueSat <= 0) {
    throw new Error(`입력 금액이 비정상이다: ${input.valueSat}`);
  }
  if (!Number.isInteger(feeSat) || feeSat < 0) {
    throw new Error(`수수료가 비정상이다: ${feeSat}`);
  }

  const outputSat = input.valueSat - feeSat;
  const dust = dustThresholdFor(destination, descriptor);
  if (outputSat < dust) {
    throw new Error(
      `출력이 dust 이하다: ${outputSat} sat < ${dust} sat. ` +
      '수수료를 낮추거나 거래 금액을 올려야 한다',
    );
  }

  const leafName = settlementLeafFor(path);
  const leafIndex = descriptor.leaves.findIndex(l => l.name === leafName);
  if (leafIndex < 0) throw new Error(`알 수 없는 리프: ${leafName}`);
  const leaf = descriptor.leaves[leafIndex]!;

  // 리프별 [control block, script||leafVersion] 쌍을 **스크립트 바이트로** 찾는다.
  // 순서에 기대면 라이브러리가 배열 순서를 바꿨을 때 조용히 다른 리프로 서명한다.
  const leafScriptHex = bytesToHex(leaf.script);
  const tapLeafScript = descriptor.tapLeafScripts.filter(
    ([, scriptWithVersion]) => bytesToHex(scriptWithVersion.slice(0, -1)) === leafScriptHex,
  );
  if (tapLeafScript.length !== 1) {
    throw new Error(`리프 ${leafName}의 서명 메타를 찾지 못했다 (${tapLeafScript.length}개)`);
  }

  const tx = new Transaction({ version: TX_VERSION, allowUnknownOutputs: true });
  tx.addInput({
    txid: input.outpoint.txid,
    index: input.outpoint.vout,
    sequence: path === 'timelock' ? descriptor.timelockBlocks : SEQUENCE_FINAL,
    witnessUtxo: {
      script: descriptor.payment.script,
      amount: BigInt(input.valueSat),
    },
    tapLeafScript,
    tapInternalKey: descriptor.payment.tapInternalKey,
    tapMerkleRoot: descriptor.payment.tapMerkleRoot,
  });
  tx.addOutput({
    script: outputScriptFor(destination, descriptor),
    amount: BigInt(outputSat),
  });
  return tx;
}

/**
 * 이 tx의 0번 입력에 서명한다. 라이브러리가 리프 스크립트에서 내 pubkey를 찾아
 * `tapScriptSig`에 넣는다.
 *
 * **내 키가 그 리프에 없으면 던진다.** 라이브러리는 `No taproot scripts signed`
 * 라는 짧은 말을 남기는데, 실제 원인은 대개 "경로를 잘못 골랐다"(예: 어드민이
 * release 리프에 서명하려 함)이거나 "주문별 키를 잘못 파생했다"이다.
 * 조용히 넘기면 **서명 없는 tx를 다 만들어놓고 마지막에** 알게 된다.
 */
export function signSettlement(tx: Transaction, privkey: Uint8Array): void {
  try {
    tx.signIdx(privkey, 0);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `이 리프에 서명할 수 없다 — 키가 스크립트에 없거나 경로가 틀렸다 (${why})`,
    );
  }
}

/** 서명을 시도하되 실패를 값으로 받는다 (여러 경로를 훑어볼 때) */
export function trySignSettlement(tx: Transaction, privkey: Uint8Array): boolean {
  try {
    signSettlement(tx, privkey);
    return true;
  } catch {
    return false;
  }
}

/** 상대에게 보낼 형식. 서명이 든 채로 PSBT로 나른다 (§5.2 `onchain-presig`) */
export function toPsbtBase64(tx: Transaction): string {
  return btoa(String.fromCharCode(...tx.toPSBT()));
}

export function fromPsbtBase64(psbt: string): Transaction {
  const binary = atob(psbt);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return Transaction.fromPSBT(bytes, { allowUnknownOutputs: true });
}

/**
 * 증인을 완성한다.
 *
 * 2서명 리프 셋은 표준 `tr_ns` 패턴이라 라이브러리가 알아서 조립한다.
 * **타임락 리프만 직접 쌓는다** — `<N> CSV DROP <C> CHECKSIG`는 라이브러리가
 * 모르는 모양이라 `finalize()`가 "Unknown tapLeafScript"로 거부한다.
 *
 * tapscript 증인 스택은 `[스크립트가 소비할 항목들..., 스크립트, control block]`이고,
 * 타임락 리프가 소비하는 건 서명 하나뿐이다.
 */
export function finalizeSettlement(tx: Transaction, path: SettlementPath): void {
  if (path !== 'timelock') {
    tx.finalize();
    return;
  }

  const input = tx.getInput(0);
  const pair = input?.tapLeafScript?.[0];
  const sig = input?.tapScriptSig?.[0]?.[1];
  if (!pair || !sig) throw new Error('타임락 증인을 만들 재료가 없다 (서명 또는 리프 메타 누락)');

  const [controlBlock, scriptWithVersion] = pair;
  tx.updateInput(0, {
    finalScriptWitness: [
      sig,
      scriptWithVersion.slice(0, -1),
      TaprootControlBlock.encode(controlBlock),
    ],
  });
}

/** 특정 키가 이 tx에 남긴 tapScript 서명 (없으면 `null`) */
export function tapScriptSigOf(tx: Transaction, xonlyHex: string): Uint8Array | null {
  const sigs = tx.getInput(0)?.tapScriptSig;
  if (!sigs) return null;
  for (const [key, sig] of sigs) {
    if (bytesToHex(key.pubKey) === xonlyHex) return sig;
  }
  return null;
}
