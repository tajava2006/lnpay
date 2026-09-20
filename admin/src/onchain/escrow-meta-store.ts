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
 * 릴레이 백업은 하지 않는다 — 잃어도 **자금이 잠기지 않는다**. 최악의 경우
 * 후원자에게 주소를 다시 받으면 되고, 사전서명도 다시 받으면 된다.
 * (어드민 **키**는 다르다. 그건 잃으면 중재가 영구 불가라 이중 백업한다.)
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

function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(metas));
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
  localStorage.removeItem(STORAGE_KEY);
}
