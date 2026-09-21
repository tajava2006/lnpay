/**
 * 에스크로 스크립트 트리 (PLAN-ONCHAIN-TRACK §3.1)
 *
 * ```
 * 내부키(key path)   BIP-341 NUMS 점 — 증명 가능하게 소모 불가
 *
 * leaf 1  release        <C> CHECKSIGVERIFY <S> CHECKSIG     정상 완료
 * leaf 2  customer-win   <A> CHECKSIGVERIFY <C> CHECKSIG     환불 · 고객 승
 * leaf 3  sponsor-win    <A> CHECKSIGVERIFY <S> CHECKSIG     후원자 승
 * leaf 4  timelock       <N> CSV DROP <C> CHECKSIG           어드민 고장 시 고객 단독 회수
 * ```
 *
 * ── 왜 MuSig2가 아닌가
 *
 * happy path를 MuSig2(C,S) 키패스로 하면 수수료가 싸고 체인에서 일반 송금과
 * 구분되지 않는다. 그런데 **논스를 재사용하면 개인키가 그대로 유출된다.**
 * 브라우저 비동기 앱에서 재시도·새로고침·다기기가 전부 재사용 경로다.
 * 스크립트 패스 2서명이 대략 40~80 vbyte 더 들 뿐이고, 그 돈에 자금 전손
 * 등급의 버그 클래스를 사지 않는다.
 *
 * ── 왜 CSV(상대 타임락)인가
 *
 * 절대 타임락(CLTV)은 펀딩이 늦어지면 보호 창이 그만큼 짧아진다. CSV는
 * **펀딩 컨펌부터** 세므로 어느 주문이든 창 길이가 같다. 그리고 그 성질 덕에
 * "원화는 언제나 T0+60분 안에 흐르고, 그때 타임락은 만기 전량 남아 있다"가
 * 성립한다(§7.3).
 *
 * ── 트리 모양을 균형으로 잡은 이유
 *
 * 4리프를 `[[1,2],[3,4]]`로 묶으면 **모든 리프의 깊이가 2**라 control block이
 * 전부 97바이트로 같다. 자주 쓰는 리프를 위로 올리면 happy path에서 32바이트
 * (≈8 vB)를 아끼지만, 그 대신 **경로마다 종결 tx 크기가 달라진다.**
 * 이 트랙은 `releaseFeeSat`을 미리 고정하고(§6.1) 환불·분쟁 수수료를 따로
 * 추정하므로, **모든 종결이 같은 크기**인 쪽이 수수료 계산을 한 줄로 만든다.
 * 8 vB와 그 단순함을 바꾼 것이다.
 */
import { Script, taprootNumsKey } from '@scure/btc-signer';
import { bytesToHex, hexToBytes } from './hex';
import type { EscrowRole, EscrowXonlyKeys } from './keys';
import { assertEscrowKeys } from './keys';

/**
 * BIP-341이 제시한 NUMS 점 (`H = lift_x(SHA256("Nothing Up My Sleeve"...))` 계열).
 * 이 x좌표에 대응하는 비밀키를 아는 사람이 없음이 증명 가능하므로,
 * **키패스로는 아무도 못 쓴다** = 반드시 위 네 리프 중 하나를 거쳐야 한다.
 *
 * 값은 테스트에서 `@scure/btc-signer`의 상수와 대조한다 — 여기 한 글자가 틀리면
 * 전혀 다른 주소가 나오고 그건 곧 전액 동결이다.
 */
export const NUMS_INTERNAL_KEY =
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

/** 타임락 리프의 기본 블록 수 — 8064블록 ≈ 8주 (§7.3 ④) */
export const DEFAULT_TIMELOCK_BLOCKS = 8064;

/**
 * CSV 블록 수의 상한. 시퀀스의 block-height 모드는 하위 16비트만 쓴다.
 * 넘기면 조용히 다른 뜻이 되므로(타입 비트 침범) 미리 막는다.
 */
export const MAX_TIMELOCK_BLOCKS = 0xffff;

export type EscrowLeafName = 'release' | 'customer-win' | 'sponsor-win' | 'timelock';

export interface EscrowLeaf {
  name: EscrowLeafName;
  /** 직렬화된 tapscript */
  script: Uint8Array;
  /** 이 리프를 쓰려면 서명해야 하는 역할들 (증인 스택 순서의 역순은 tx 빌더가 다룬다) */
  signers: readonly EscrowRole[];
}

/** NUMS 점을 바이트로 (호출할 때마다 새 복사본 — 공유 가변 배열을 돌리지 않는다) */
export function numsInternalKey(): Uint8Array {
  return hexToBytes(NUMS_INTERNAL_KEY);
}

function assertTimelock(blocks: number): void {
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > MAX_TIMELOCK_BLOCKS) {
    throw new Error(
      `타임락 블록 수가 범위 밖이다: ${blocks} (1 ~ ${MAX_TIMELOCK_BLOCKS})`,
    );
  }
}

/**
 * 네 리프를 **고정된 순서로** 만든다. 순서가 트리 모양을 정하고 트리 모양이
 * 주소를 정하므로, 이 배열 순서는 규약의 일부다 — 바꾸면 기존 주문의 주소가 바뀐다.
 */
export function buildEscrowLeaves(
  keys: EscrowXonlyKeys,
  timelockBlocks: number = DEFAULT_TIMELOCK_BLOCKS,
): readonly EscrowLeaf[] {
  assertEscrowKeys(keys);
  assertTimelock(timelockBlocks);

  const C = hexToBytes(keys.customer);
  const S = hexToBytes(keys.sponsor);
  const A = hexToBytes(keys.admin);

  return [
    {
      name: 'release',
      script: Script.encode([C, 'CHECKSIGVERIFY', S, 'CHECKSIG']),
      signers: ['customer', 'sponsor'],
    },
    {
      name: 'customer-win',
      script: Script.encode([A, 'CHECKSIGVERIFY', C, 'CHECKSIG']),
      signers: ['admin', 'customer'],
    },
    {
      name: 'sponsor-win',
      script: Script.encode([A, 'CHECKSIGVERIFY', S, 'CHECKSIG']),
      signers: ['admin', 'sponsor'],
    },
    {
      name: 'timelock',
      script: Script.encode([timelockBlocks, 'CHECKSEQUENCEVERIFY', 'DROP', C, 'CHECKSIG']),
      signers: ['customer'],
    },
  ];
}

/**
 * `@scure/btc-signer`의 `p2tr`에 넘길 트리. 균형 이진 트리로 **직접** 짠다 —
 * `taprootListToTree`(허프만)는 가중치에 따라 모양이 달라져서, 라이브러리
 * 버전이 올라가며 배치 규칙이 바뀌면 **같은 키에서 다른 주소**가 나올 수 있다.
 * 주소가 흔들리는 건 자금 유실이므로 모양을 우리가 못박는다.
 */
export function buildEscrowTree(leaves: readonly EscrowLeaf[]) {
  if (leaves.length !== 4) {
    throw new Error(`에스크로 트리는 리프가 정확히 4개여야 한다 (받은 값: ${leaves.length})`);
  }
  const [release, customerWin, sponsorWin, timelock] = leaves as readonly [
    EscrowLeaf, EscrowLeaf, EscrowLeaf, EscrowLeaf,
  ];
  return [
    [{ script: release.script }, { script: customerWin.script }],
    [{ script: sponsorWin.script }, { script: timelock.script }],
  ];
}

/** 디버깅·감사용 — 리프 스크립트를 사람이 읽는 형태로 */
export function describeLeafScript(script: Uint8Array): string {
  return Script.decode(script)
    .map(op => (op instanceof Uint8Array ? bytesToHex(op) : String(op)))
    .join(' ');
}

/** 우리가 박아둔 NUMS 상수가 라이브러리 값과 같은지 (테스트와 부팅 점검용) */
export function numsMatchesLibrary(): boolean {
  return bytesToHex(taprootNumsKey()) === NUMS_INTERNAL_KEY;
}
