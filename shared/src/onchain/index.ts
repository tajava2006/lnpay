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
 * ⚠️ 지켜야 할 규칙: **비트코인 경로에 두 번째 구현을 들이지 않는다.**
 * 필요한 건 `@scure/btc-signer`가 재수출하는 것(`utils.pubSchnorr` 등)이나
 * WebCrypto로 해결한다. hex 변환을 `@scure/base` 대신 직접 짠 이유도 이것이다.
 *
 * **예외 하나 — `@noble/curves` (P3에서 생겼다).** 사전서명을 검증하려면
 * schnorr `verify`가 필요한데 btc-signer가 그걸 재수출하지 않는다. 그래서
 * **btc-signer가 쓰는 바로 그 버전을 정확히 핀해서**(`2.4.0`, 캐럿 없음)
 * 직접 의존으로 달았다 — `pnpm why` 기준 **한 인스턴스로 합쳐진다.**
 *
 * ⚠️ `update-deps.sh`가 `pnpm up --latest`를 돌리므로 이 핀은 **자동으로 깨진다.**
 * 그래서 `onchain-tx.test.ts`에 **btc-signer가 만든 서명을 우리 verify가
 * 받아들이는지** 보는 테스트를 뒀다. 갈리면 거기서 걸린다.
 */
export { bytesToHex, hexToBytes, isXonlyHex } from './hex';

export {
  onchainOrderTags,
  parseOnchainOrder,
  onchainOrderIssues,
  formatOutpoint,
  parseOutpoint,
} from './order';
export type { OnchainOrder, OnchainOrderEvent } from './order';

export {
  MAX_ORDER_EXPIRY_SEC, FUNDING_WINDOW_SEC, PRESIGN_WINDOW_SEC, ACCOUNT_WINDOW_SEC,
  KRW_WINDOW_SEC, COSIGN_WINDOW_SEC, COSIGN_GRACE_WARNING_SEC, SETTLING_WARN_SEC,
  DISPUTE_ESCALATION_SEC, MAX_OPTION_WINDOW_SEC, MAX_TRADE_DURATION_SEC,
  DISPUTE_RULING_BUDGET_SEC, ONCHAIN_EVENT_HORIZON_SEC, TERMINAL_GRACE_SEC,
  fundingDeadlineFrom, presignDeadlineFrom, accountDeadlineFrom, krwDeadlineFrom,
  cosignDeadlineFrom, isOrderExpiryAllowed, currentOnchainDeadline, durationText, ONCHAIN_WINDOWS,
  presignDeadlineOf, accountDeadlineOf, cosignDeadlineOf, krwDeadlineOf, isPast,
  onchainOrderEventExpiration, onchainMessageExpiration,
} from './timing';
export type { DeadlineViewer, OnchainDeadline, OnchainWindows } from './timing';

export { isOnchainClaimPayload, isOnchainPsbtPayload, isOnchainOrderRequestPayload } from './requests';
export type {
  OnchainRequest, OnchainOrderRequestMsg, OnchainClaimMsg, OnchainPresigMsg,
  OnchainCosignMsg, OnchainDisputeMsg, OnchainRejectedMsg,
  OnchainClaimPayload, OnchainPsbtPayload, OnchainOrderRequestPayload,
} from './requests';

export {
  MIN_RELEASE_FEERATE, MAX_RELEASE_FEERATE_MULTIPLIER, MAX_RELEASE_FEERATE_FLOOR,
  MAX_RELEASE_FEE_SHARE, RESERVE_MIN_GAP_PERCENT, MAX_SANE_SETTLEMENT_FEERATE,
  releaseFeerateProblem, reserveProblem, requiredConfirmations,
} from './policy';

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
  canActOnSignRequest,
  isRefundKind,
  signPurposeFor,
  awaitingSignerFor,
} from './state-machine';
export type {
  OnchainState, SettlementKind, NonTxOutcome, OnchainOutcome,
  BondDisposition, OutcomeRule, SignPurpose,
} from './state-machine';

export { ONCHAIN_STATE_DISPLAY, onchainStateDisplay } from './display';

export {
  ONCHAIN_PROGRESS_STEPS,
  onchainStepActor,
  resolveOnchainProgress,
  settlementSummary,
} from './progress';
export type {
  OnchainRole, StepStatus, OnchainStepActor, StepAction, OnchainProgressStep,
  OnchainProgressContext, ResolvedOnchainStep, OnchainProgress, OnchainTerminalInfo,
  OnchainRefundingInfo,
} from './progress';

export {
  TYPICAL_SETTLEMENT_VSIZE,
  buildSettlementTx,
  settlementLeafFor,
  estimateSettlementVsize,
  settlementFeeSat,
  dustThresholdFor,
  outputScriptFor,
  signSettlement,
  trySignSettlement,
  finalizeSettlement,
  toPsbtBase64,
  fromPsbtBase64,
  fromRawHex,
  tapScriptSigOf,
  settlementPathForKind,
  addTapScriptSig,
  outputAddressOf,
  leafOfWitness,
  buildKeyPathSweep,
} from './tx';
export type { Outpoint, SettlementPath, BuildSettlementParams, KeyPathUtxo } from './tx';

export { verifyPresignature, leafHashOf, outputGoesTo } from './verify';

export { MempoolChainAdapter, DEFAULT_MEMPOOL_API } from './chain';
export type {
  ChainAdapter, ChainQuery, ChainNetwork, ChainAdapterConfig,
  ChainOutpoint, ChainUtxo, AddressFunds, TxStatus, FeeEstimates, SpendInfo,
} from './chain';
export type { PresigVerdict, VerifyPresignatureParams } from './verify';

export {
  deriveEscrowAddress,
  verifyEscrowAddress,
  assertEscrowAddress,
  deriveSingleKeyAddress,
  addressProblem,
} from './address';
export { networkParamsFor } from './address';
export { explorerAddressUrl, explorerTxUrl } from './explorer';
export type {
  BtcNetworkName, EscrowAddressParams, EscrowDescriptor, EscrowAddressCheck, TapLeafScripts,
} from './address';
