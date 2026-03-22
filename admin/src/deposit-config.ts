/**
 * 보증금 비율 설정
 *
 * Admin localStorage에 저장. 0이면 보증금 비활성 (기존 플로우).
 */

const CUSTOMER_KEY = 'admin:customerDepositPercent';
const SPONSOR_KEY = 'admin:sponsorDepositPercent';

function readPercent(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 0;
  } catch {
    return 0;
  }
}

function writePercent(key: string, percent: number): void {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  localStorage.setItem(key, String(clamped));
}

/** 고객 보증금 비율 */
export function getCustomerDepositPercent(): number { return readPercent(CUSTOMER_KEY); }
export function setCustomerDepositPercent(percent: number): void { writePercent(CUSTOMER_KEY, percent); }

/** 후원자 보증금 비율 */
export function getSponsorDepositPercent(): number { return readPercent(SPONSOR_KEY); }
export function setSponsorDepositPercent(percent: number): void { writePercent(SPONSOR_KEY, percent); }
