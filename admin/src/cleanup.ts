/**
 * localStorage 만료 삭제 스케줄러
 *
 * 만료된 오더와 연관 요청을 주기적으로 삭제한다.
 * 상태 무관 — expiration 기준으로만 판단한다.
 */
import { purgeExpired } from './order-store';
import { purgeByOrderIds } from './request-store';

const CLEANUP_INTERVAL = 60_000; // 60초
let timer: ReturnType<typeof setInterval> | null = null;

function runCleanup(): void {
  const expiredOrderIds = purgeExpired();
  if (expiredOrderIds.length > 0) {
    purgeByOrderIds(expiredOrderIds);
    console.log('[Cleanup] Purged', expiredOrderIds.length, 'expired orders + related requests');
  }
}

export function startCleanup(): void {
  if (timer) return;
  runCleanup(); // 즉시 1회 실행
  timer = setInterval(runCleanup, CLEANUP_INTERVAL);
}

export function stopCleanup(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
