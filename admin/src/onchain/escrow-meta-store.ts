/**
 * 주문별 로컬 메타 (PLAN-ONCHAIN-TRACK §5.1 · §6.1b)
 *
 * 어드민이 알아야 하지만 **공개 이벤트에 싣지 않는** 값들이다.
 *
 * | 값 | 왜 로컬인가 |
 * |---|---|
 * | 후원자의 받을 주소 | **실제 지갑 주소**다. 공개하면 제3자가 그 지갑을 따라간다 |
 * | 희망 feerate | 주소와 같이 오고, 공개할 이유가 없다 |
 * | 사전서명 PSBT | 그 안에 받을 주소가 들어 있다 |
 *
 * ── 백업 방침을 뒤집었다 (§9.1, 2026-09-23)
 *
 * 원래는 백업하지 않았다. 근거는 *"잃어도 자금이 잠기지 않는다 — 후원자에게
 * 주소를 다시 받으면 된다"* 였는데, **다시 받을 경로가 코드에 없다.** 그리고
 * 워처 소유권을 한 기기로 못박으면서 **기기 이전이 버튼 하나**가 됐다. 그
 * 상태로 옮기면 진행 중인 주문마다 릴리스 수수료를 못 구해 `anomaly`가 뜨고,
 * 보증금 몰수에 필요한 프리이미지 키(`sponsorDepositKey`)도 사라진다.
 *
 * 그래서 NIP-78 + NIP-44로 백업한다 — **공개 이벤트에 싣지 않는다**는 원칙은
 * 그대로다. 프리이미지도 같은 이유로 같은 방식으로 이미 백업하고 있다.
 * 백업은 `backup.ts`가 건다(이 파일은 릴레이를 모른다 — 헌법).
 */
const STORAGE_KEY = 'admin:onchain-meta';

export interface OnchainEscrowMeta {
  orderId: string;
  /** 후원자가 받을 주소 (§6.1b — 후원자가 정한다) */
  payoutAddress?: string;
  /** 릴리스 tx에 쓸 feerate (sat/vB). 부담자가 정한다 */
  feerateSatPerVb?: number;
  /** 후원자 사전서명이 든 PSBT (base64) */
  presigPsbt?: string;
  /**
   * 보증금 홀드 인보이스의 **프리이미지 저장 키**.
   *
   * 몰수하려면 프리이미지가 필요한데, 그건 `escrow-store`에 인보이스를 만들 때
   * 쓴 id로 들어가 있다. 그 id를 규칙으로 다시 만들려 하면(`slice(0,8)` 같은)
   * 규칙이 바뀌는 순간 **몰수를 못 하게 된다.** 만들 때 그대로 적어둔다.
   */
  customerDepositKey?: string;
  sponsorDepositKey?: string;

  /**
   * 고객이 의뢰 때 낸 **환불 받을 주소**(리뷰 #8). 환불·고객승·구조 tx가 여기로 간다.
   * 후원자 주소와 같은 이유로 공개 이벤트에 싣지 않는다.
   */
  refundAddress?: string;

  /**
   * 보증금 HTLC가 만료될 것으로 **추정**되는 시각(unix초).
   *
   * 몰수는 결정 시점에 집행되므로(리뷰 #8), 판정이 이 시각을 넘기면 몰수할 게 없다.
   * 분쟁 화면에 남은 시간을 보여주는 데 쓴다. 블록 간격이 흔들리므로 추정치다.
   */
  customerBondExpiresAt?: number;
  sponsorBondExpiresAt?: number;

  /**
   * 고객이 계좌를 보낼 때 공개 태그에 단 **솔티드 커밋먼트**. 분쟁 때 후원자가 받은
   * 계좌와 솔트를 채팅에 공개하면 이것과 대조한다(계좌 이의 판정의 근거, 리뷰 #8).
   */
  accountCommitment?: string;

  /**
   * 브로드캐스트 직전 기록 (outbox).
   *
   * **발행(settling) → 브로드캐스트** 순서를 지키기 위한 칸이다. 전에는 브로드캐스트한
   * 뒤 발행했는데, 발행이 실패하면 체인에는 tx가 떠 있고 장부에는 없어서 워처가
   * 그걸 리오그로 읽었다(리뷰 #8). raw tx를 남겨야 멤풀에서 쫓겨났을 때 **같은 tx를
   * 다시 뿌릴 수 있다**(O-005) — 전에는 안 남겨서 그것도 불가능했다.
   * 받는 주소가 들어 있으므로 공개하지 않는다(이 메타는 NIP-44로 백업된다).
   */
  outbox?: {
    txid: string;
    rawHex: string;
    kind: string;
  };
}

type MetaMap = Record<string, OnchainEscrowMeta>;

function load(): MetaMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as MetaMap) : {};
  } catch {
    return {};
  }
}

let metas: MetaMap = load();

/** 바뀔 때마다 불린다. `backup.ts`가 릴레이 백업을 여기 건다 */
let onChanged: (() => void) | null = null;

export function setEscrowMetaHook(fn: (() => void) | null): void {
  onChanged = fn;
}

function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(metas));
  onChanged?.();
}

export function getAllEscrowMeta(): OnchainEscrowMeta[] {
  return Object.values(metas);
}

/**
 * 백업본에서 **비어 있는 칸만** 채운다.
 *
 * 주문 단위가 아니라 **칸 단위**로 합친다 — 사전서명은 이 기기에서 받고
 * 주소는 백업에만 있는 상태가 실제로 생긴다(핸드오버 직후).
 */
export function mergeEscrowMetas(entries: OnchainEscrowMeta[]): number {
  let touched = 0;
  for (const entry of entries) {
    const local = metas[entry.orderId];
    const merged: Record<string, unknown> = { ...entry, orderId: entry.orderId };
    // `undefined`를 덮어쓰기로 취급하면 백업본이 로컬의 빈 칸에 지워진다.
    for (const [key, value] of Object.entries(local ?? {})) {
      if (value !== undefined) merged[key] = value;
    }
    if (local && canon(merged) === canon(local)) continue;
    metas = { ...metas, [entry.orderId]: merged as unknown as OnchainEscrowMeta };
    touched += 1;
  }
  if (touched > 0) save();
  return touched;
}

/** 키 순서에 흔들리지 않는 비교용 직렬화 */
function canon(value: object): string {
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(entries);
}

export function getEscrowMeta(orderId: string): OnchainEscrowMeta | undefined {
  return metas[orderId];
}

export function mergeEscrowMeta(orderId: string, patch: Omit<OnchainEscrowMeta, 'orderId'>): void {
  metas = { ...metas, [orderId]: { ...metas[orderId], orderId, ...patch } };
  save();
}

export function deleteEscrowMeta(orderId: string): void {
  if (!metas[orderId]) return;
  const { [orderId]: _gone, ...rest } = metas;
  metas = rest;
  save();
}

/** @testing-only */
export function _resetForTesting(): void {
  metas = {};
  onChanged = null;
  localStorage.removeItem(STORAGE_KEY);
}
