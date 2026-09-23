/**
 * 구조(`rescue`) 요청 — 약정 밖의 자금을 고객에게 돌려주는 `{A,C}` tx (리뷰 #8)
 *
 * 약정과 다른 모양으로 들어온 자금이 있다: 금액이 1 sat만 달라도(거래소 출금이
 * 수수료를 금액에서 떼는 흔한 경우), 두 번 보냈거나, 취소 직후 늦게 컨펌됐거나,
 * 확정 뒤 같은 주소로 또 보냈거나. 전에는 이걸 볼 곳도 돌려줄 길도 없어서 8주
 * 타임락이 유일한 출구였다(그 UI도 없었다).
 *
 * FSM 밖에 둔다 — 가격도 보증금도 안 건드리는, 주소에 남은 돈을 주인에게 돌려주는
 * 일이다. 그래서 여기 기록은 **잃어도 된다**: 어드민이 마지막에 서명하므로, 잃으면
 * 요청을 다시 보내고 고객이 다시 서명하면 그만이다.
 */
const STORE_KEY = 'admin:onchain-rescues';

export interface OnchainRescue {
  orderId: string;
  txid: string;
  vout: number;
  valueSat: number;
  /** 고객에게 보여준 그 tx의 수수료 — 서명을 검증할 때 같은 tx를 다시 만든다 */
  feeSat: number;
  destination: string;
  createdAt: number;
  /** 브로드캐스트했으면 그 txid */
  broadcastTxid?: string;
}

type RescueMap = Record<string, OnchainRescue>;

export function rescueKey(orderId: string, txid: string, vout: number): string {
  return `${orderId}:${txid}:${vout}`;
}

function load(): RescueMap {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as RescueMap) : {};
  } catch {
    return {};
  }
}

let rescues: RescueMap = load();

function save(): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(rescues));
}

export function putRescue(entry: OnchainRescue): void {
  rescues = { ...rescues, [rescueKey(entry.orderId, entry.txid, entry.vout)]: entry };
  save();
}

export function getRescue(orderId: string, txid: string, vout: number): OnchainRescue | undefined {
  return rescues[rescueKey(orderId, txid, vout)];
}

export function markRescueBroadcast(orderId: string, txid: string, vout: number, broadcastTxid: string): void {
  const key = rescueKey(orderId, txid, vout);
  const entry = rescues[key];
  if (!entry) return;
  rescues = { ...rescues, [key]: { ...entry, broadcastTxid } };
  save();
}

/** @testing-only */
export function _resetForTesting(): void {
  rescues = {};
  localStorage.removeItem(STORE_KEY);
}
