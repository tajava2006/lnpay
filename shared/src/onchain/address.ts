/**
 * 에스크로 주소 파생과 **독립 검증** (PLAN-ONCHAIN-TRACK §3.4)
 *
 * ── 이 파일의 존재 이유는 검증이다
 *
 * 고객이 돈을 보내는 주소가 **정말 자기 키가 들어간 2-of-3인지**를 앱이 스스로
 * 확인해야 한다. 어드민이 알려준 주소를 그냥 믿으면, 어드민이 악의적이거나
 * 침해당했을 때 전액을 잃는다(공격 G).
 *
 * → 세 pubkey를 전부 오더 이벤트에 싣고, **각 클라이언트가 주소를 직접 파생해
 *   대조**한다. 불일치면 진행을 막는다. **타협 대상이 아니다.**
 *
 * 그래서 파생과 검증이 같은 파일에 있고, 검증은 "어드민이 준 값"을 하나도
 * 쓰지 않는다 — 오로지 세 키와 타임락 블록 수만으로 다시 만든다.
 */
import { Address, NETWORK, TEST_NETWORK, p2tr } from '@scure/btc-signer';
import type { TaprootScriptTree } from '@scure/btc-signer/payment.js';
import { bytesToHex, hexToBytes, isXonlyHex } from './hex';
import type { EscrowXonlyKeys } from './keys';
import type { EscrowLeaf } from './script';
import {
  DEFAULT_TIMELOCK_BLOCKS,
  buildEscrowLeaves,
  buildEscrowTree,
  numsInternalKey,
} from './script';

export type BtcNetworkName = 'mainnet' | 'signet' | 'testnet' | 'regtest';

/**
 * regtest 파라미터는 라이브러리가 안 들고 있어서 직접 적는다.
 * signet은 주소 형식이 testnet과 같아(`tb`) `TEST_NETWORK`를 그대로 쓴다.
 */
const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef } as const;

export function networkParamsFor(network: BtcNetworkName) {
  switch (network) {
    case 'mainnet': return NETWORK;
    case 'signet':
    case 'testnet': return TEST_NETWORK;
    case 'regtest': return REGTEST;
  }
}

export interface EscrowAddressParams {
  keys: EscrowXonlyKeys;
  network: BtcNetworkName;
  /** 스크립트에 박히는 실제 값. 오더 이벤트의 `timelock-blocks` 태그와 같아야 한다 */
  timelockBlocks?: number;
}

/** p2tr 결과 타입을 추론으로 받는다 (오버로드라 직접 쓰기 번거롭다) */
function p2trWithTree(
  internalKey: Uint8Array,
  tree: TaprootScriptTree,
  network: ReturnType<typeof networkParamsFor>,
) {
  // allowUnknownOutputs: 우리 리프는 표준 패턴(p2tr_pk 등)이 아니라서 켜야 한다.
  return p2tr(internalKey, tree, network, true);
}

/** PSBT 입력에 넣는 `[control block, script||leafVersion]` 쌍 */
export type TapLeafScripts = NonNullable<ReturnType<typeof p2trWithTree>['tapLeafScript']>;

export interface EscrowDescriptor {
  address: string;
  /** scriptPubKey (hex) — 체인에서 이 출력을 찾을 때 쓴다 */
  scriptPubKey: string;
  /** taproot 머클 루트 (hex) */
  tapMerkleRoot: string;
  leaves: readonly EscrowLeaf[];
  timelockBlocks: number;
  network: BtcNetworkName;
  /** PSBT 입력에 그대로 넣는 서명 메타 (control block 포함) — tx 빌더가 쓴다 */
  payment: ReturnType<typeof p2trWithTree>;
  /**
   * `payment.tapLeafScript`를 **있음이 보장된 형태로** 다시 내놓는다.
   * 타입상 optional이라 호출부마다 `!`를 찍게 되는데, 그러면 "없을 수도 있다"는
   * 신호가 사라진다. 여기서 한 번 확인하고 넘긴다.
   */
  tapLeafScripts: TapLeafScripts;
}

/**
 * 세 키 + 타임락 → 에스크로 taproot 주소.
 *
 * 키 형식 검사와 **세 키 상이 검사**는 `buildEscrowLeaves`가 먼저 한다 —
 * 겹친 키로는 주소가 아예 안 나온다(§3.3, 공격 H).
 */
export function deriveEscrowAddress(params: EscrowAddressParams): EscrowDescriptor {
  const timelockBlocks = params.timelockBlocks ?? DEFAULT_TIMELOCK_BLOCKS;
  const leaves = buildEscrowLeaves(params.keys, timelockBlocks);
  const payment = p2trWithTree(
    numsInternalKey(),
    buildEscrowTree(leaves),
    networkParamsFor(params.network),
  );

  if (!payment.address) {
    throw new Error('deriveEscrowAddress: 주소를 만들지 못했다');
  }
  const tapLeafScripts = payment.tapLeafScript;
  if (!tapLeafScripts || tapLeafScripts.length !== leaves.length) {
    throw new Error('deriveEscrowAddress: 리프별 서명 메타가 비었다');
  }

  return {
    address: payment.address,
    scriptPubKey: bytesToHex(payment.script),
    tapMerkleRoot: bytesToHex(payment.tapMerkleRoot),
    leaves,
    timelockBlocks,
    network: params.network,
    payment,
    tapLeafScripts,
  };
}

/**
 * 주문별 키 하나로 만드는 단일키 taproot 주소 (키패스).
 *
 * ── 왜 필요한가: **환불은 고객이 없을 때 일어난다**
 *
 * `refund:*`와 `customer_win`은 에스크로를 고객에게 돌려주는데, **어느 주소로**
 * 보낼지를 플랜이 정해두지 않았다. 고객에게 물어보는 건 최악이다 — 환불이
 * 발동하는 순간이 바로 **고객이 응답하지 않는** 순간이기 때문이다(마감 초과,
 * 분쟁 무응답). 물어볼 수 없을 때 물어봐야 하는 설계가 된다.
 *
 * → **고객의 주문별 x-only 키로 주소를 만든다.** 추가 왕복이 0이고, 고객은
 *   nostr 키에서 그 키를 **언제든 다시 파생**할 수 있어 잃을 수가 없다.
 *   주문마다 다르므로 주소 재사용도 없다.
 *
 * 후원자는 반대다 — 클레임할 때 **직접 깨어 있으므로** 받을 주소를 자기가 낸다
 * (§6.1b). 활동 중인 쪽은 지정하고, 부재할 수 있는 쪽은 결정론으로 받는다.
 */
export function deriveSingleKeyAddress(xonly: string, network: BtcNetworkName): string {
  if (!isXonlyHex(xonly)) throw new Error('단일키 주소: x-only 형식이 아니다');
  const out = p2tr(hexToBytes(xonly), undefined, networkParamsFor(network));
  if (!out.address) throw new Error('단일키 주소를 만들지 못했다');
  return out.address;
}

/**
 * 이 네트워크에서 **받을 수 있는** 주소인가. 문제가 있으면 사유, 없으면 `null`.
 *
 * 유저가 입력한 주소(환불 주소·받을 주소)를 받는 자리에서 쓴다. 틀린 네트워크의
 * 주소를 받아두면 **종결 tx를 만드는 순간**에야 터진다 — 그때는 거래가 이미 굴러간 뒤다.
 */
export function addressProblem(address: string, network: BtcNetworkName): string | null {
  const trimmed = address.trim();
  if (!trimmed) return '주소가 비어 있습니다';
  try {
    Address(networkParamsFor(network)).decode(trimmed);
    return null;
  } catch {
    return `${network} 네트워크의 비트코인 주소가 아닙니다`;
  }
}

export type EscrowAddressCheck =
  | { ok: true; descriptor: EscrowDescriptor }
  | { ok: false; reason: string; derived?: string };

/**
 * 어드민이 발행한 주소를 **직접 다시 만들어** 대조한다.
 *
 * 실패를 예외가 아니라 값으로 돌려주는 이유: 호출부가 화면에 "주소가 일치하지
 * 않습니다 — 이 주문에 돈을 보내지 마세요"를 띄워야 하고, 그 문구에 사유가
 * 필요하다. 그냥 throw면 상위에서 뭉개기 쉽다.
 */
export function verifyEscrowAddress(
  params: EscrowAddressParams,
  expectedAddress: string,
): EscrowAddressCheck {
  let descriptor: EscrowDescriptor;
  try {
    descriptor = deriveEscrowAddress(params);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (descriptor.address !== expectedAddress) {
    return {
      ok: false,
      reason: '어드민이 발행한 주소가 내 키로 파생한 주소와 다르다',
      derived: descriptor.address,
    };
  }
  return { ok: true, descriptor };
}

/** 검증을 통과해야만 진행하는 자리용 (펀딩 직전 등) */
export function assertEscrowAddress(
  params: EscrowAddressParams,
  expectedAddress: string,
): EscrowDescriptor {
  const check = verifyEscrowAddress(params, expectedAddress);
  if (!check.ok) {
    throw new Error(
      `에스크로 주소 검증 실패: ${check.reason}` +
        (check.derived ? ` (내가 파생한 주소: ${check.derived})` : ''),
    );
  }
  return check.descriptor;
}
