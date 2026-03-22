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

export function setDepositBolt11(orderId: string, bolt11: string): void {
  const existing = deposits[orderId];
  if (existing?.bolt11 === bolt11) return;
  deposits = { ...deposits, [orderId]: { ...existing, bolt11 } };
  save();
  notify();
}

export function setDepositStatus(orderId: string, status: 'accepted' | 'cancelled' | 'settled'): void {
  const existing = deposits[orderId];
  if (existing?.status === status) return;
  deposits = { ...deposits, [orderId]: { ...existing, bolt11: existing?.bolt11 ?? '', status } };
  save();
  notify();
}
