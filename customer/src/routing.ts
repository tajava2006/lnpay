/**
 * 주소 ↔ 화면 상태
 *
 * ── 왜 따로 떼어냈나
 *
 * **새로고침해야만 드러나는 자리**다. 잘못돼도 앱을 쓰는 동안에는 멀쩡해 보이고,
 * 주소창을 다시 읽는 순간(새로고침·알림 클릭·공유 링크)에만 틀린다.
 * 온체인 트랙은 마감이 분 단위인 구간이 있어(계좌 공개 15분 / 송금 30분)
 * 그때 자리를 잃으면 그 시간을 그냥 까먹는다.
 */

/** 거래 방법. 라이트닝과 온체인은 **동등한 층위**다 */
export type Track = 'ln' | 'onchain';

/**
 * 탭. **두 트랙이 키를 공유한다** — 자리마다 역할이 같다:
 * `request` = 내가 내놓는 쪽, `fulfill` = 남의 것을 받는 쪽, `history` = 내 거래
 */
export type Tab = 'request' | 'fulfill' | 'history';

export const DEFAULT_TRACK: Track = 'ln';
export const DEFAULT_TAB: Tab = 'fulfill';

export interface Route {
  track: Track;
  tab: Tab;
  orderId: string | null;
}

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const rawTab = params.get('tab');

  return {
    track: params.get('track') === 'onchain'
      // 구버전 링크(`?tab=onchain`)를 살려둔다 — 알림에 실려 나간 주소가 있다.
      || rawTab === 'onchain' ? 'onchain' : DEFAULT_TRACK,
    tab: rawTab === 'request' || rawTab === 'fulfill' || rawTab === 'history'
      ? rawTab : DEFAULT_TAB,
    orderId: params.get('order') || null,
  };
}

/**
 * 기본 화면(라이트닝 + 사주기)은 **쿼리 없이 루트**다 — 주소가 짧을수록
 * 알림에서 돌아왔을 때 덜 낯설고, 공유할 때도 깔끔하다.
 */
export function urlFor(track: Track, tab: Tab, orderId?: string | null): string {
  const params = new URLSearchParams();
  if (track !== DEFAULT_TRACK) params.set('track', track);
  if (tab !== DEFAULT_TAB) params.set('tab', tab);
  if (orderId) params.set('order', orderId);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}
