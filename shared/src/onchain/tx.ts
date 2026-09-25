/**
 * 종결 tx 빌더 (T-109 · T-110 · T-112 · T-115)
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
 * 여기서는 한 모양으로 만들고, 장부에서만 가른다.
 *
 * ── 어드민 출력을 달지 않는다
 *
 * 중재료는 **몰수된 보증금에서** 충당한다. 분쟁 tx에 어드민 출력을
 * 달면 승자가 받을 금액이 깎이고 tx도 커진다. 그래서 어느 경로든 **출력은 하나**다.
 *
 * ── RBF 신호를 끈다 (T-115)
 *
 * 모든 입력의 nSequence를 final(`0xffffffff`)로 둔다. 다만 **이게 교체를 막는
 * 장치는 아니다** — full-RBF(Bitcoin Core 28+ 기본)에서는 신호가 없어도 수수료가
 * 높은 충돌 tx가 이긴다. 교체를 실제로 막는 건 **2-of-3**이다:
 * 에스크로를 쓰는 다른 tx를 만들려면 **다른 서명 짝**이 필요하다. 그래서 어드민은
 * 언제나 **마지막에** 서명하고, 고객 손에 완성 가능한 환불 tx가 들려 있는 순간을
 * 만들지 않는다(`daemon/src/onchain/flow.ts`).
 *
 * 신호를 끄는 이유는 단순함이다 — 교체하려면 상대 서명이 또 필요해서 RBF로 얻는 게
 * 없고, 경로마다 다르게 두면 그 자체가 버그 자리다. 막히면 **받는 쪽이 CPFP** 한다(T-112).
 *
 * 예외는 `timelock`뿐이다 — CSV를 만족시키려면 nSequence가 **블록 수 그 자체**여야 한다.
 */
import { Address, OutScript, TaprootControlBlock, Transaction, p2tr, utils } from '@scure/btc-signer';
import { tapLeafHash } from '@scure/btc-signer/payment.js';
import { bytesToHex, hexToBytes } from './hex';
import type { BtcNetworkName, EscrowDescriptor } from './address';
import { networkParamsFor } from './address';
import type { EscrowLeafName } from './script';

export interface Outpoint {
  txid: string;
  vout: number;
}

export type SettlementPath = 'release' | 'refund' | 'customer-win' | 'sponsor-win' | 'timelock';

/** 사유 → 리프 경로. 환불·고객승·구조는 전부 `{A,C}`다 */
export function settlementPathForKind(kind: string): SettlementPath {
  if (kind === 'release') return 'release';
  if (kind === 'sponsor_win') return 'sponsor-win';
  if (kind === 'customer_win') return 'customer-win';
  return 'refund';
}

/** BIP-68 상대 타임락은 **tx version 2 이상**에서만 동작한다. */
const TX_VERSION = 2;

/** RBF 비활성 (T-115) */
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
 * **전에** 종결 수수료를 알아야 해서 필요하다. 실제 tx를 만들 때는
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
 * 그래야 사전서명을 검증할 때 "내가 만든 것과 같은가"로 대조할 수 있다(T-109).
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

/** 상대에게 보낼 형식. 서명이 든 채로 PSBT로 나른다 (`onchain-presig`) */
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
 * 브로드캐스트용 원본 hex를 tx로 되읽는다. outbox는 **hex만** 남기므로(어드민
 * `escrow-meta-store`) 그 바이트가 무엇을 어디로 보내는지 확인할 때 쓴다 —
 * 가짜 체인·드릴 도구처럼 `@scure/btc-signer`를 직접 들이지 않는 쪽에서.
 */
export function fromRawHex(hex: string): Transaction {
  return Transaction.fromRaw(hexToBytes(hex), { allowUnknownOutputs: true });
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

/**
 * 특정 키가 이 tx에 남긴 tapScript 서명 (없으면 `null`).
 *
 * `leafScript`를 주면 **그 리프에 대한 서명만** 찾는다. 한 PSBT에 여러 리프의 서명이
 * 섞일 수 있어서(악의적인 PSBT가 다른 리프 서명을 끼워 넣는 경우) 키만으로 고르면
 * 엉뚱한 서명을 집는다.
 */
export function tapScriptSigOf(
  tx: Transaction,
  xonlyHex: string,
  leafScript?: Uint8Array,
): Uint8Array | null {
  const sigs = tx.getInput(0)?.tapScriptSig;
  if (!sigs) return null;
  const wantLeaf = leafScript ? bytesToHex(tapLeafHash(leafScript)) : null;
  for (const [key, sig] of sigs) {
    if (bytesToHex(key.pubKey) !== xonlyHex) continue;
    if (wantLeaf && bytesToHex(key.leafHash) !== wantLeaf) continue;
    return sig;
  }
  return null;
}

/**
 * 상대 서명 하나를 **우리가 직접 만든 tx에** 옮겨 심는다.
 *
 * 받은 PSBT에 그대로 서명하면 그 PSBT가 무엇을 담았는지(어느 리프, 어느 주소)를
 * 상대 말만 믿는 셈이 된다(T-120 — 어드민이 보낸 "환불"이 공격자 주소로 가는
 * `{A,C}` tx여도 화면은 "내 에스크로가 맞다"고 했다). 그래서 서명할 tx는 **언제나
 * 우리 기록으로 다시 만들고**, 상대에게서는 서명 바이트만 가져온다. 그 서명이
 * 이 tx·이 리프에 대해 유효한지는 `verifyPresignature`가 먼저 확인한다.
 */
export function addTapScriptSig(
  tx: Transaction,
  leafScript: Uint8Array,
  signerXonlyHex: string,
  sig: Uint8Array,
): void {
  tx.updateInput(0, {
    tapScriptSig: [[
      { pubKey: hexToBytesStrict(signerXonlyHex), leafHash: tapLeafHash(leafScript) },
      sig,
    ]],
  }, true);
}

/** 이 tx의 0번 출력이 가는 주소 (화면에 보여주고, 기대한 주소와 대조할 때) */
export function outputAddressOf(tx: Transaction, descriptor: EscrowDescriptor): string | null {
  const out = tx.getOutput(0);
  if (!out?.script) return null;
  try {
    return Address(networkParamsFor(descriptor.network)).encode(OutScript.decode(out.script));
  } catch {
    return null;
  }
}

/**
 * 에스크로를 소모한 입력의 증인 → 어느 리프로 썼는가.
 *
 * tapscript 경로의 증인은 `[…스크립트가 먹는 항목, 스크립트, control block]`이다.
 * 끝에서 두 번째가 리프 스크립트이므로 그걸 우리 네 리프와 대조한다. 키패스는
 * NUMS라 불가능하고, 모르는 모양이면 `null`이다 — 추측하지 않는다.
 */
export function leafOfWitness(
  witness: readonly string[] | null | undefined,
  descriptor: EscrowDescriptor,
): EscrowLeafName | null {
  if (!witness || witness.length < 2) return null;
  const scriptHex = witness[witness.length - 2]!.toLowerCase();
  const leaf = descriptor.leaves.find(l => bytesToHex(l.script) === scriptHex);
  return leaf?.name ?? null;
}

export interface KeyPathUtxo {
  txid: string;
  vout: number;
  valueSat: number;
}

/**
 * 단일키 taproot 주소(`tr(주문별 키)`)에 있는 자금을 내 지갑으로 보낸다.
 *
 * 옛 주문의 환불은 이 주소로 갔다 — 이 앱만 쓸 수 있는 주소다. 꺼내는 화면이
 * 없어서 환불금이 사실상 갇혀 있었고, 환불 tx가 수수료 부족으로 막혀도 CPFP를 못 했다.
 * 이 함수가 그 출구다. 멤풀에 있는 출력도 입력으로 받으므로 **CPFP로도 쓴다.**
 *
 * vsize는 한 번 서명해 재고 다시 만든다 — Schnorr 서명이 64바이트 고정이라 두 번째
 * tx도 크기가 같다.
 */
export function buildKeyPathSweep(params: {
  privkey: Uint8Array;
  network: BtcNetworkName;
  utxos: readonly KeyPathUtxo[];
  destination: string;
  feerateSatPerVb: number;
}): { tx: Transaction; feeSat: number; outputSat: number } {
  const { privkey, network, utxos, destination, feerateSatPerVb } = params;
  if (utxos.length === 0) throw new Error('보낼 UTXO가 없다');
  if (!Number.isFinite(feerateSatPerVb) || feerateSatPerVb <= 0) {
    throw new Error(`feerate가 비정상이다: ${feerateSatPerVb}`);
  }
  const net = networkParamsFor(network);
  const pay = p2tr(utils.pubSchnorr(privkey), undefined, net);
  const total = utxos.reduce((n, u) => n + u.valueSat, 0);
  const outScript = OutScript.encode(Address(net).decode(destination));

  const build = (feeSat: number): Transaction => {
    const tx = new Transaction({ version: TX_VERSION, allowUnknownOutputs: true });
    for (const u of utxos) {
      tx.addInput({
        txid: u.txid,
        index: u.vout,
        sequence: SEQUENCE_FINAL,
        witnessUtxo: { script: pay.script, amount: BigInt(u.valueSat) },
        tapInternalKey: pay.tapInternalKey,
      });
    }
    tx.addOutput({ script: outScript, amount: BigInt(total - feeSat) });
    tx.sign(privkey);
    tx.finalize();
    return tx;
  };

  const probe = build(0);
  const feeSat = Math.ceil(probe.vsize * feerateSatPerVb);
  const outputSat = total - feeSat;
  const dust = DUST_BY_TYPE[Address(net).decode(destination).type] ?? DUST_FALLBACK;
  if (outputSat < dust) {
    throw new Error(`수수료를 빼면 dust 이하다: ${outputSat} sat < ${dust} sat`);
  }
  return { tx: build(feeSat), feeSat, outputSat };
}

function hexToBytesStrict(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('x-only hex가 아니다');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
