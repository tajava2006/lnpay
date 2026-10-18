/**
 * 지정 거래 스팸 억제 — 두 트랙 공용 (RISKS R-16)
 *
 * 지정 의뢰는 보증금이 없어 공짜다. 공개 오더북에는 안 뜨지만 **지정된 후원자와 운영자에게는** 스팸이 될 수 있다 — 상대 npub만
 * 알면 누구나 의뢰를 쏟아부어 그 사람의 "나를 지정한 거래" 목록·푸시와 운영자 DM을 채운다. 막는 건 둘이다:
 *
 * - 고객 키 하나가 수락 대기 지정 의뢰를 트랙마다 `MAX_OPEN_DESIGNATED_PER_CUSTOMER`개까지(각 트랙 store의 `openDesignatedCount`)
 * - 도착 푸시(지정 대상마다)와 운영자 DM은 `DESIGNATED_QUIET_SEC`에 한 번 — 키를 여러 개 만들어도 폰은 몇 번만 울린다
 *
 * 키를 계속 새로 만들면 목록은 여전히 찬다 — 거기까진 막지 않는다(수용). 막을 수단은 보증금뿐인데 그건 이 기능의 취지와 반대다.
 */
import { nowSec, type AdminContext } from '../admin/context';

export const DESIGNATED_QUIET_SEC = 10 * 60;

/** 이 키로 마지막에 울린 뒤 조용한 창이 지났으면 지금으로 적고 true. 창 안이면 false(울리지 않는다) */
export function designatedQuietOver(ctx: Pick<AdminContext, 'db' | 'nowMs'>, key: string): boolean {
  const now = nowSec(ctx);
  if (now - Number(ctx.db.kvGet(`designated.quiet:${key}`) ?? 0) < DESIGNATED_QUIET_SEC) return false;
  ctx.db.kvSet(`designated.quiet:${key}`, String(now));
  return true;
}

/**
 * 운영자 목록이 지난 부팅과 다르면 true — 그리고 지금 목록을 적는다. 스냅샷은 **발행할 때의** 운영자에게만 가므로, 운영자를
 * 더하면 상태가 더 안 바뀌는(특히 끝난) 지정 거래는 새 운영자 앱에 영영 안 뜬다(2026-10-18 리뷰). 운영자 목록은 설정이라
 * 바뀌려면 데몬이 다시 뜬다 — 그래서 부팅 때 한 번 보고, 바뀌었으면 트랙이 지정 거래 스냅샷을 다시 낸다.
 */
export function operatorsChanged(ctx: Pick<AdminContext, 'db' | 'operators'>, track: 'ln' | 'onchain'): boolean {
  const key = `designated.operators:${track}`;
  const current = [...ctx.operators].sort().join(',');
  if (ctx.db.kvGet(key) === current) return false;
  ctx.db.kvSet(key, current);
  return true;
}
