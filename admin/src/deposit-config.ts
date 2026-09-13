/**
 * 보증금 비율 설정
 *
 * **앱 전역 설정이다.** 기기별로 갈리면 어느 기기가 order-request를 받았느냐에
 * 따라 보증금을 요구하기도 하고 안 하기도 하는 상태가 된다. 그래서 localStorage를
 * 캐시로 쓰되 NIP-78로 릴레이에 동기화한다(app-state-backup).
 *
 * 충돌은 addressable event 기본 규칙대로 마지막 쓰기가 이긴다 — Admin이
 * 한 사람이라 이걸로 충분하다.
 *
 * 0이면 보증금 비활성. 현재 운영 기본값이 0이라 위 메커니즘은 꺼져 있다.
 */
import { publishAppState, fetchAppState, BACKUP_TAGS } from './nostr/app-state-backup';

interface DepositSettings {
  customer: number;
  sponsor: number;
}

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
  void syncSettings();
}

function syncSettings(): Promise<void> {
  const settings: DepositSettings = {
    customer: readPercent(CUSTOMER_KEY),
    sponsor: readPercent(SPONSOR_KEY),
  };
  return publishAppState(BACKUP_TAGS.settings, settings).catch(err =>
    console.warn('[DepositConfig] 설정 동기화 실패:', err),
  );
}

/**
 * 릴레이의 설정을 가져와 로컬에 반영한다. 부팅 시 1회 호출.
 *
 * 전역 설정이므로 원격이 우선이다 — pending deposit 복원(로컬 우선)과 방향이
 * 반대인데, 이쪽은 "이 기기가 방금 만든 것"이라는 개념이 없기 때문이다.
 */
export async function restoreDepositSettings(): Promise<boolean> {
  const remote = await fetchAppState<DepositSettings>(BACKUP_TAGS.settings);
  if (!remote) return false;

  if (typeof remote.customer === 'number') {
    localStorage.setItem(CUSTOMER_KEY, String(Math.max(0, Math.min(100, Math.round(remote.customer)))));
  }
  if (typeof remote.sponsor === 'number') {
    localStorage.setItem(SPONSOR_KEY, String(Math.max(0, Math.min(100, Math.round(remote.sponsor)))));
  }
  console.log('[DepositConfig] 릴레이에서 설정 복원:', remote);
  return true;
}

/** 고객 보증금 비율 */
export function getCustomerDepositPercent(): number { return readPercent(CUSTOMER_KEY); }
export function setCustomerDepositPercent(percent: number): void { writePercent(CUSTOMER_KEY, percent); }

/** 후원자 보증금 비율 */
export function getSponsorDepositPercent(): number { return readPercent(SPONSOR_KEY); }
export function setSponsorDepositPercent(percent: number): void { writePercent(SPONSOR_KEY, percent); }
