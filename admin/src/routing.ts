/**
 * 주소 ↔ 어드민 화면 (유저 앱 `customer/src/routing.ts`와 같은 방식)
 *
 * 예전엔 탭과 고른 오더를 React 상태로만 들고 있어서 **새로고침하면 데몬 탭 첫 화면으로 돌아갔다**
 * (2026-09-24). 분쟁을 보다가 새로고침 한 번에 자리를 잃고, 링크로 오더를 가리킬 수도 없었다.
 *
 * `?tab=ln&order=<id>` — 데몬 탭(기본)은 쿼리 없이 루트다. 오더는 트랙 탭에서만 뜻이 있다.
 */

export type Tab = 'daemon' | 'ln' | 'onchain';

export interface Route {
  tab: Tab;
  /** 트랙 탭에서 고른 오더. 없으면 목록 */
  orderId: string | null;
}

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const raw = params.get('tab');
  const tab: Tab = raw === 'ln' || raw === 'onchain' ? raw : 'daemon';
  return { tab, orderId: tab === 'daemon' ? null : params.get('order') || null };
}

export function urlFor(route: Route): string {
  const params = new URLSearchParams();
  if (route.tab !== 'daemon') params.set('tab', route.tab);
  if (route.tab !== 'daemon' && route.orderId) params.set('order', route.orderId);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}
