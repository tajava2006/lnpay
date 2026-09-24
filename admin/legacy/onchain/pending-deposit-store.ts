/**
 * 온체인 보증금 대기 (PLAN-ONCHAIN-TRACK §4.1b)
 *
 * **클레임은 상태가 아니다.** 보증금 인보이스를 발행하고 결제를 기다리는 구간은
 * FSM 밖의 사이드 스토어다 — 그래야 "한 푼도 안 내고 오더를 묶어두는" 무료
 * 예약 그리핑이 안 생긴다. 여러 후원자가 동시에 시도해도 되고, **먼저 결제한
 * 쪽이 가져간다.**
 *
 * ⚠️ 라이트닝의 `pending-deposit-store`와 **따로 둔다.** 거기 엔트리는
 * 라이트닝 워처가 집어 **라이트닝 오더**를 만든다 — 섞이면 온체인 보증금 결제가
 * 엉뚱한 트랙의 주문을 만든다.
 *
 * ── 릴레이 백업이 필요한 이유 (§9.1)
 *
 * 이 상태는 **릴레이 이벤트로 재구성할 수 없다.** 인보이스는 어드민이 로컬에서
 * 만든 것이고 오더는 아직 없다. 기기를 옮기면 새 기기는 그 인보이스의 존재를
 * 모르고, 후원자가 그걸 결제하면 **아무도 결제를 감지하지 못한다** — 후원자
 * 돈이 CLTV 만료까지 HTLC에 갇힌다. 라이트닝이 같은 이유로 NIP-78 백업을
 * 두고 있고(`app-state-backup`), 여기도 같다. 백업은 `backup.ts`가 건다 —
 * 이 파일은 저장소일 뿐 릴레이를 모른다(헌법).
 */
const STORAGE_KEY = 'admin:onchain-pending-deposits';

export interface OnchainPendingDeposit {
  /** 고객 의뢰는 아직 오더가 없다 — 이 id로 나중에 오더를 만든다 */
  orderId: string;
  type: 'customer' | 'sponsor';
  /** 후원자 보증금이면 그 후원자 */
  sponsorPubkey?: string;
  customerPubkey: string;
  depositPaymentHash: string;
  depositBolt11: string;
  amountSat: number;
  createdAt: number;

  // ── 고객 의뢰(type='customer')가 오더를 만들 때 필요한 것 ──
  /** 고객이 파는 수량 */
  tradeAmountSat?: number;
  reserveKrw?: number;
  expiration?: number;
  customerXonly?: string;
  /** 고객이 낸 환불 주소 (암호문에서 풀어 둔 것) — **공개 이벤트에 싣지 않는다** */
  refundAddress?: string;
  /** 이 인보이스에 요구한 최종 CLTV(블록) — 보증금 만료 추정에 쓴다 */
  cltvBlocks?: number;

  // ── 후원자 클레임(type='sponsor')이 `bonded`로 갈 때 필요한 것 ──
  sponsorXonly?: string;
  /** 프리이미지 저장 키 (몰수할 때 필요하다) */
  escrowKey?: string;
  /** 복호화해 둔 받을 주소 — **공개 이벤트에 싣지 않는다** */
  payoutAddress?: string;
  feerateSatPerVb?: number;
}

/** 키: 고객은 orderId, 후원자는 `orderId:sponsorPubkey` (동시 클레임 허용) */
type DepositMap = Record<string, OnchainPendingDeposit>;

function load(): DepositMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DepositMap) : {};
  } catch {
    return {};
  }
}

let deposits: DepositMap = load();

/** 바뀔 때마다 불린다. `backup.ts`가 릴레이 백업을 여기 건다 */
let onChanged: (() => void) | null = null;

export function setOnchainDepositHook(fn: (() => void) | null): void {
  onChanged = fn;
}

function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deposits));
  onChanged?.();
}

export function depositKey(entry: Pick<OnchainPendingDeposit, 'orderId' | 'type' | 'sponsorPubkey'>): string {
  return entry.type === 'customer' ? entry.orderId : `${entry.orderId}:${entry.sponsorPubkey}`;
}

export function putOnchainDeposit(entry: OnchainPendingDeposit): void {
  deposits = { ...deposits, [depositKey(entry)]: entry };
  save();
}

export function getOnchainDeposits(): OnchainPendingDeposit[] {
  return Object.values(deposits);
}

export function getOnchainDepositsFor(orderId: string): OnchainPendingDeposit[] {
  return Object.values(deposits).filter(d => d.orderId === orderId);
}

/**
 * 백업본에서 **비어 있는 자리만** 채운다.
 *
 * 로컬이 이긴다 — 이 기기가 방금 만든 인보이스가 옛 백업에 밀리면 안 된다.
 */
export function mergeOnchainDeposits(entries: OnchainPendingDeposit[]): number {
  let added = 0;
  for (const entry of entries) {
    const key = depositKey(entry);
    if (deposits[key]) continue;
    deposits = { ...deposits, [key]: entry };
    added += 1;
  }
  if (added > 0) save();
  return added;
}

export function deleteOnchainDeposit(key: string): void {
  if (!deposits[key]) return;
  const { [key]: _gone, ...rest } = deposits;
  deposits = rest;
  save();
}

/** @testing-only */
export function _resetForTesting(): void {
  deposits = {};
  onChanged = null;
  localStorage.removeItem(STORAGE_KEY);
}
