/**
 * 발행 이벤트의 만료 태그
 *
 * 릴레이는 NIP-40에 따라 **이미 지난 `expiration`을 가진 이벤트를 거절한다.**
 * 실측(2026-09-19): nos.lol·relay.wisp.talk 둘 다 `invalid: event expired`.
 *
 * 그래서 만료된 오더를 종결하면 상태 발행이 전부 실패했다 — 에스크로는 환불됐는데
 * 양쪽은 왜 끝났는지 영영 모르고, 화면엔 옛 상태가 남았다.
 */
import { describe, it, expect } from 'vitest';
import type { Order } from '@sajwo-tracker/shared';
import { publishExpiration } from '../nostr/publish';

const NOW = 1_700_000_000;
const WEEK = 7 * 24 * 3600;
const o = (state: Order['state'], expiration: number) => ({ state, expiration });

describe('publishExpiration', () => {
  describe('종결 상태 + 이미 만료', () => {
    it.each(['paid', 'cancelled', 'sponsor_wins', 'customer_wins', 'admin_closed'] as const)(
      '%s — 유예를 준다 (안 주면 릴레이가 거절해 아무도 못 본다)',
      state => {
        expect(publishExpiration(o(state, NOW - 3600), NOW)).toBe(NOW + WEEK);
      },
    );
  });

  describe('진행 중인 오더는 건드리지 않는다', () => {
    /**
     * 만료를 늘리면 끝난 줄 알았던 거래가 되살아난 것처럼 보인다.
     * 종결 이벤트에만 유예를 주는 이유다.
     */
    it.each(['requested', 'claimed', 'verified', 'escrowed', 'invoiced', 'remitted'] as const)(
      '%s — 원래 값 그대로',
      state => {
        expect(publishExpiration(o(state, NOW - 3600), NOW)).toBe(NOW - 3600);
        expect(publishExpiration(o(state, NOW + 3600), NOW)).toBe(NOW + 3600);
      },
    );
  });

  it('아직 만료 전인 종결은 원래 값을 쓴다 — 공연히 늘리지 않는다', () => {
    expect(publishExpiration(o('paid', NOW + 3600), NOW)).toBe(NOW + 3600);
  });

  it('정확히 지금 만료면 유예를 준다 — 경계에서 거절당하지 않게', () => {
    expect(publishExpiration(o('admin_closed', NOW), NOW)).toBe(NOW + WEEK);
  });
});
