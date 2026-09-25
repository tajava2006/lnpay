/**
 * 사전서명 검증 (T-110 · O-003)
 *
 * ── 왜 진짜로 검증해야 하나
 *
 * 후원자의 사전서명이 통과하면 **고객이 계좌 정보를 발행한다**(O-003). 그 뒤
 * 후원자가 원화를 보내고, 고객이 서명을 얹어 릴리스한다.
 *
 * 만약 사전서명이 엉터리인데 통과시키면, 그 사실이 드러나는 건 **원화가 이미
 * 오간 뒤**다. 릴리스가 완성되지 않고 분쟁으로 떨어진다. 구조 검사만으로는
 * 못 잡는다 — 바이트 길이는 맞는데 서명이 틀린 경우가 정확히 그 경우다.
 *
 * 그래서 여기서 **서명을 실제로 검증한다.**
 *
 * ── 대조 방식: txid
 *
 * 서명은 증인(witness)에 들어가므로 **txid에 영향을 주지 않는다.** 그래서
 * "내가 만든 tx"와 "상대가 서명한 tx"의 txid가 같으면 입력·출력·금액·시퀀스·
 * locktime이 **전부** 같다는 뜻이다. 필드를 하나씩 비교하다 빠뜨릴 자리가 없다.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { SigHash, Transaction } from '@scure/btc-signer';
import { tapLeafHash } from '@scure/btc-signer/payment.js';
import { bytesToHex, hexToBytes, isXonlyHex } from './hex';
import type { BuildSettlementParams } from './tx';
import { buildSettlementTx, fromPsbtBase64, settlementLeafFor, tapScriptSigOf } from './tx';

/** BIP-342 tapscript 리프 버전 */
const TAP_LEAF_VERSION = 0xc0;

export type PresigVerdict =
  /** `sig`·`leafScript`는 검증을 통과한 그 서명과 리프 — 우리 tx에 옮겨 심을 때 쓴다 */
  | { ok: true; tx: Transaction; txid: string; sig: Uint8Array; leafScript: Uint8Array }
  | { ok: false; reason: string };

export interface VerifyPresignatureParams {
  /** 상대가 보낸 PSBT (base64) */
  psbtBase64: string;
  /** **우리가 직접** 만들 tx의 재료. 상대가 준 값을 그대로 쓰면 검증이 아니다 */
  expected: BuildSettlementParams;
  /** 서명했어야 하는 키 (x-only hex) */
  signerXonly: string;
}

/**
 * 받은 PSBT가 **우리가 기대한 그 tx**이고, **그 키의 서명이 유효한지** 본다.
 *
 * 실패를 예외가 아니라 값으로 돌려준다 — 어드민 화면이 사유를 보여줘야 하고,
 * 사유가 "형식이 틀림"인지 "서명이 안 맞음"인지에 따라 대응이 다르다.
 */
export function verifyPresignature(params: VerifyPresignatureParams): PresigVerdict {
  const { psbtBase64, expected, signerXonly } = params;

  if (!isXonlyHex(signerXonly)) {
    return { ok: false, reason: '서명자 키 형식이 x-only hex가 아니다' };
  }

  let mine: Transaction;
  try {
    mine = buildSettlementTx(expected);
  } catch (e) {
    return { ok: false, reason: `기대 tx를 만들지 못했다: ${msg(e)}` };
  }

  let theirs: Transaction;
  try {
    theirs = fromPsbtBase64(psbtBase64);
  } catch (e) {
    return { ok: false, reason: `PSBT를 읽지 못했다: ${msg(e)}` };
  }

  if (theirs.inputsLength !== 1 || theirs.outputsLength !== 1) {
    return {
      ok: false,
      reason: `입력 1개·출력 1개여야 한다 (받은 값: 입력 ${theirs.inputsLength}, 출력 ${theirs.outputsLength})`,
    };
  }

  // txid가 같으면 입력·출력·금액·시퀀스·locktime이 전부 같다 (서명은 증인이라 무관).
  if (theirs.id !== mine.id) {
    return { ok: false, reason: describeMismatch(mine, theirs) };
  }

  const leafName = settlementLeafFor(expected.path);
  const leaf = expected.descriptor.leaves.find(l => l.name === leafName);
  if (!leaf) return { ok: false, reason: `알 수 없는 리프: ${leafName}` };

  // **이 리프에 대한** 서명만 본다 — 다른 리프 서명을 끼워 넣은 PSBT를 걸러낸다.
  const sig = tapScriptSigOf(theirs, signerXonly, leaf.script);
  if (!sig) return { ok: false, reason: '그 키의 서명이 PSBT에 없다' };
  if (sig.length !== 64) {
    // SIGHASH_DEFAULT가 아니면 65바이트가 된다. 우리 양쪽 앱이 내는 서명은
    // 언제나 DEFAULT이므로, 다른 길이는 "다른 구현이 서명했다"는 신호다.
    return { ok: false, reason: `서명 길이가 64가 아니다: ${sig.length}` };
  }

  let sighash: Uint8Array;
  try {
    sighash = mine.preimageWitnessV1(
      0,
      [expected.descriptor.payment.script],
      SigHash.DEFAULT,
      [BigInt(expected.input.valueSat)],
      undefined,
      leaf.script,
      TAP_LEAF_VERSION,
    );
  } catch (e) {
    return { ok: false, reason: `sighash를 계산하지 못했다: ${msg(e)}` };
  }

  let valid = false;
  try {
    valid = schnorr.verify(sig, sighash, hexToBytes(signerXonly));
  } catch (e) {
    return { ok: false, reason: `서명 검증이 실패했다: ${msg(e)}` };
  }
  if (!valid) return { ok: false, reason: '서명이 이 tx에 대한 것이 아니다' };

  return { ok: true, tx: theirs, txid: theirs.id, sig, leafScript: leaf.script };
}

/**
 * 리프 해시 — `tapScriptSig` 항목이 어느 리프용인지 가른다.
 *
 * 한 tx에 여러 리프의 서명이 섞일 수 있어서(사전서명 재사용 시도 등) 키만으로
 * 고르면 엉뚱한 서명을 검증하게 된다.
 */
export function leafHashOf(script: Uint8Array): string {
  return bytesToHex(tapLeafHash(script, TAP_LEAF_VERSION));
}

function describeMismatch(mine: Transaction, theirs: Transaction): string {
  const parts: string[] = [];
  const mineIn = mine.getInput(0);
  const theirsIn = theirs.getInput(0);
  const mineOut = mine.getOutput(0);
  const theirsOut = theirs.getOutput(0);

  if (bytesToHex(mineIn?.txid ?? new Uint8Array()) !== bytesToHex(theirsIn?.txid ?? new Uint8Array())
      || mineIn?.index !== theirsIn?.index) {
    parts.push('소모하는 UTXO가 다르다');
  }
  if (mineOut?.amount !== theirsOut?.amount) {
    parts.push(`금액이 다르다 (기대 ${mineOut?.amount}, 받음 ${theirsOut?.amount})`);
  }
  if (bytesToHex(mineOut?.script ?? new Uint8Array()) !== bytesToHex(theirsOut?.script ?? new Uint8Array())) {
    parts.push('받는 주소가 다르다');
  }
  if (mineIn?.sequence !== theirsIn?.sequence) {
    parts.push(`nSequence가 다르다 (기대 ${mineIn?.sequence}, 받음 ${theirsIn?.sequence})`);
  }
  if (mine.version !== theirs.version || mine.lockTime !== theirs.lockTime) {
    parts.push('version/locktime이 다르다');
  }
  return parts.length > 0
    ? `기대한 tx가 아니다 — ${parts.join(', ')}`
    : '기대한 tx가 아니다 (txid 불일치)';
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
