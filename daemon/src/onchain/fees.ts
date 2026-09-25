/**
 * 네트워크 수수료 캐시 — 워처가 채우고 핸들러가 읽는다
 *
 * 핸들러는 네트워크를 부르지 않는다(트랜잭션 안에서 판단한다). 그래서 보증금 하한·최소 거래액·릴리스
 * feerate 상한·종결 수수료는 **워처가 몇 분마다 받아 둔 값**으로 계산한다. 오래됐으면(`FEES_MAX_AGE_SEC`)
 * 없는 것으로 친다 — 낡은 수수료로 결정하면 tx가 멤풀에서 썩는다.
 */
import type { FeeEstimates } from '@sajwo-tracker/shared/onchain';
import type { Db } from '../db';

const KEY = 'oc.fees';

/** 워처가 추정치를 새로 받는 간격 */
export const FEES_REFRESH_SEC = 2 * 60;

/** 이보다 오래된 추정치는 쓰지 않는다 — 갱신이 한두 번 실패해도 버틴다 */
export const FEES_MAX_AGE_SEC = 10 * 60;

export function saveFees(db: Db, fees: FeeEstimates, at: number): void {
  db.kvSet(KEY, JSON.stringify({ at, fees }));
}

export function currentFees(db: Db, now: number): FeeEstimates | null {
  const raw = db.kvGet(KEY);
  if (!raw) return null;
  try {
    const { at, fees } = JSON.parse(raw) as { at: number; fees: FeeEstimates };
    return now - at <= FEES_MAX_AGE_SEC ? fees : null;
  } catch {
    return null;
  }
}
