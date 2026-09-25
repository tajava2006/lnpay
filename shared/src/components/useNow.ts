import { useEffect, useState } from 'react';
import { nowSec } from '../time';

/**
 * 지금(unix초)을 주기적으로 다시 그린다 — 마감이 지나는 순간 버튼이 닫히고 카운트다운이 움직여야 한다.
 * @param intervalMs 다시 그리는 간격 (기본 1초)
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(nowSec);
  useEffect(() => {
    const id = setInterval(() => setNow(nowSec()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
