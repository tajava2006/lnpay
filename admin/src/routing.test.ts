/**
 * 어드민 주소 — 새로고침하면 보던 자리로 돌아온다 (2026-09-24)
 */
import { describe, expect, it } from 'vitest';
import { parseRoute, urlFor, type Route } from './routing';

describe('주소 왕복', () => {
  it.each<Route>([
    { tab: 'daemon', orderId: null },
    { tab: 'ln', orderId: null },
    { tab: 'ln', orderId: 'ab12cd' },
    { tab: 'onchain', orderId: 'oc-9' },
  ])('%o', route => {
    expect(parseRoute(urlFor(route).slice(1))).toEqual(route);
  });

  it('데몬 탭은 쿼리 없이 루트', () => {
    expect(urlFor({ tab: 'daemon', orderId: null })).toBe('/');
  });
});

describe('이상한 주소', () => {
  it('모르는 탭은 데몬 탭', () => {
    expect(parseRoute('?tab=nope&order=x')).toEqual({ tab: 'daemon', orderId: null });
  });

  it('데몬 탭의 오더는 뜻이 없다 — 버린다', () => {
    expect(parseRoute('?order=x')).toEqual({ tab: 'daemon', orderId: null });
    expect(urlFor({ tab: 'daemon', orderId: 'x' })).toBe('/');
  });

  it('빈 오더는 목록', () => {
    expect(parseRoute('?tab=ln&order=')).toEqual({ tab: 'ln', orderId: null });
  });
});
