/**
 * 보증금 비율 설정
 *
 * Admin localStorage에 저장. 0이면 보증금 비활성 (기존 플로우).
 */

const STORAGE_KEY = 'admin:depositPercent';

export function getDepositPercent(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 0;
  } catch {
    return 0;
  }
}

export function setDepositPercent(percent: number): void {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  localStorage.setItem(STORAGE_KEY, String(clamped));
}
