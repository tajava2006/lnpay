/**
 * 온체인 트랙 (2-of-3 taproot 에스크로) 공용 모듈.
 *
 * 라이트닝 트랙과 **의도적으로 분리**돼 있다 — 상태·탭·`CLIENT_TAG`가 다르고,
 * 온체인 트랙은 독립적으로 붙였다 뗐다 할 수 있어야 한다(PLAN §1).
 * 그래서 메인 `index.ts`가 아니라 `@sajwo-tracker/shared/onchain`로 나간다.
 *
 * ── crypto 인스턴스 (PLAN §3.5의 "단일 인스턴스 확인")
 *
 * `pnpm why @noble/curves` 기준으로 트리에 **두 벌**이 있다:
 *   - `2.0.1` ← nostr-tools (nostr 서명)
 *   - `2.4.0` ← @scure/btc-signer (비트코인 서명)
 *
 * **합칠 수 없고, 합칠 이유도 없다.** noble/scure 계열은 공급망 이유로 의존성을
 * 정확 버전으로 핀하므로 override로 억지로 맞추면 상류의 의도를 깨는 것이다.
 * 그리고 위험했던 상황(ark SDK)은 *같은 서명 경로*가 두 인스턴스를 섞어 쓰는
 * 경우였다. 여기서는 경로가 완전히 갈린다 — 이 디렉토리의 코드는 비트코인
 * 쪽만 쓰고, 두 세계는 **원시 바이트만** 주고받는다(키 객체를 넘기지 않는다).
 *
 * ⚠️ 지켜야 할 규칙: **이 디렉토리에서는 `@noble/*`·`@scure/base`를 직접
 * import하지 않는다.** 필요한 건 `@scure/btc-signer`가 재수출하는 것만 쓰거나
 * (`utils.pubSchnorr` 등) WebCrypto로 한다. 직접 의존을 달면 그 순간
 * 비트코인 경로에 두 번째 인스턴스가 생긴다.
 */
export { bytesToHex, hexToBytes, isXonlyHex } from './hex';

export {
  ORDER_KEY_PREFIX,
  isValidScalar,
  xonlyFromPrivkey,
  deriveOrderKey,
  generateOrderKey,
  findDuplicateEscrowKey,
  assertEscrowKeys,
} from './keys';
export type { OrderKey, EscrowXonlyKeys, EscrowRole } from './keys';

export {
  NUMS_INTERNAL_KEY,
  DEFAULT_TIMELOCK_BLOCKS,
  MAX_TIMELOCK_BLOCKS,
  numsInternalKey,
  buildEscrowLeaves,
  buildEscrowTree,
  describeLeafScript,
  numsMatchesLibrary,
} from './script';
export type { EscrowLeaf, EscrowLeafName } from './script';

export {
  ONCHAIN_STATES,
  ONCHAIN_TRANSITIONS,
  ONCHAIN_TERMINAL_STATES,
  SETTLEMENT_KINDS,
  NON_TX_OUTCOMES,
  OUTCOME_RULES,
  PRICE_VALIDITY_MS,
  canOnchainTransition,
  isOnchainTerminal,
  forfeitUse,
  canCancelOnchain,
  canSendAccountInfoOnchain,
  canAutoRelease,
  isPriceStale,
} from './state-machine';
export type {
  OnchainState, SettlementKind, NonTxOutcome, OnchainOutcome,
  BondDisposition, OutcomeRule,
} from './state-machine';

export { ONCHAIN_STATE_DISPLAY, onchainStateDisplay } from './display';

export {
  ONCHAIN_PROGRESS_STEPS,
  onchainStepActor,
  resolveOnchainProgress,
} from './progress';
export type {
  OnchainRole, StepStatus, OnchainStepActor, StepAction, OnchainProgressStep,
  OnchainProgressContext, ResolvedOnchainStep, OnchainProgress, OnchainTerminalInfo,
} from './progress';

export {
  deriveEscrowAddress,
  verifyEscrowAddress,
  assertEscrowAddress,
} from './address';
export type {
  BtcNetworkName, EscrowAddressParams, EscrowDescriptor, EscrowAddressCheck, TapLeafScripts,
} from './address';
