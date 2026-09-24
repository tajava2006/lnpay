/**
 * 후원자 보증금 상태 저장소
 *
 * Admin으로부터 수신한 deposit-required/accepted/cancelled/settled 알림을 추적한다.
 * UI 전용 — order-store와 별도로 관리.
 */

type Listener = () => void;

export interface SponsorDeposit {
  bolt11: string;
  status?: 'accepted' | 'cancelled' | 'settled';
  /** 인보이스 알림의 created_at — 이보다 옛 알림은 **이전 클레임의 인보이스** 것이다 */
  at?: number;
  /** 상태 알림의 created_at */
  statusAt?: number;
}

type DepositMap = Record<string, SponsorDeposit>;

const STORAGE_KEY = 'sponsor:deposits';

let deposits: DepositMap = load();
const listeners = new Set<Listener>();

function load(): DepositMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deposits));
}

function notify(): void {
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): DepositMap {
  return deposits;
}

/**
 * 보증금 인보이스가 왔다.
 *
 * 클레임이 풀렸다가 다시 잡히면 같은 오더에 인보이스가 또 온다. 예전엔 옛 인보이스의 상태("환불됨")가
 * 그대로 남아 **새 인보이스의 결제 칸이 안 떴다**. 알림은 순서 없이 다시 올 수 있어서(새로고침 때 재구독)
 * 이벤트 시각으로 가른다 — 인보이스보다 옛 상태는 옛 인보이스 것이다.
 */
export function setDepositBolt11(orderId: string, bolt11: string, at: number): void {
  const existing = deposits[orderId];
  if (existing?.bolt11 === bolt11) return;
  if (existing?.at !== undefined && at < existing.at) return; // 옛 인보이스가 늦게 도착
  const keepStatus = existing?.status && existing.statusAt !== undefined && existing.statusAt >= at;
  deposits = {
    ...deposits,
    [orderId]: { bolt11, at, ...(keepStatus ? { status: existing.status, statusAt: existing.statusAt } : {}) },
  };
  save();
  notify();
}

export function setDepositStatus(orderId: string, status: 'accepted' | 'cancelled' | 'settled', at: number): void {
  const existing = deposits[orderId];
  if (existing?.at !== undefined && at < existing.at) return; // 지금 인보이스보다 옛 알림
  if (existing?.statusAt !== undefined && at < existing.statusAt) return;
  if (existing?.status === status) return;
  deposits = { ...deposits, [orderId]: { ...existing, bolt11: existing?.bolt11 ?? '', status, statusAt: at } };
  save();
  notify();
}
