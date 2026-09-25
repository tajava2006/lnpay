/**
 * 주소 ↔ 화면 상태
 *
 * **새로고침해야만 드러나는 자리**라 테스트로 못박는다. 온체인 트랙은 마감이
 * 분 단위인 구간이 있어(계좌 공개 15분 / 송금 30분), 새로고침 한 번에 보던
 * 자리를 잃으면 그 시간을 그냥 까먹는다.
 */
import { describe, it, expect } from 'vitest';
import { parseRoute, urlFor } from '../routing';

describe('주소 읽기', () => {
  it('아무것도 없으면 기본 화면 (라이트닝 + 사주기)', () => {
    expect(parseRoute('')).toEqual({ track: 'ln', tab: 'fulfill', orderId: null });
  });

  it('트랙과 탭을 따로 읽는다', () => {
    expect(parseRoute('?track=onchain&tab=request'))
      .toEqual({ track: 'onchain', tab: 'request', orderId: null });
  });

  it('주문이 있으면 같이 읽는다', () => {
    expect(parseRoute('?track=onchain&tab=history&order=oc-1').orderId).toBe('oc-1');
  });

  /** 알림에 이미 실려 나간 주소가 있다 — 깨뜨리면 안 된다. */
  it('구버전 링크(?tab=onchain)도 온체인으로 연다', () => {
    const route = parseRoute('?tab=onchain');
    expect(route.track).toBe('onchain');
    expect(route.tab).toBe('fulfill');   // 모르는 탭 값은 기본으로
  });

  it('모르는 값은 기본으로 떨어뜨린다', () => {
    expect(parseRoute('?track=liquid&tab=nope'))
      .toEqual({ track: 'ln', tab: 'fulfill', orderId: null });
  });

  it('빈 order는 null이다 (빈 문자열로 상세를 열지 않는다)', () => {
    expect(parseRoute('?order=').orderId).toBeNull();
  });
});

describe('주소 만들기', () => {
  /** 주소가 짧을수록 알림에서 돌아왔을 때 덜 낯설다. */
  it('기본 화면은 쿼리 없이 루트', () => {
    expect(urlFor('ln', 'fulfill')).toBe('/');
  });

  it.each([
    ['ln', 'request', undefined, '/?tab=request'],
    ['ln', 'history', undefined, '/?tab=history'],
    ['onchain', 'fulfill', undefined, '/?track=onchain'],
    ['onchain', 'history', undefined, '/?track=onchain&tab=history'],
    ['onchain', 'history', 'oc-1', '/?track=onchain&tab=history&order=oc-1'],
  ] as const)('%s / %s / %s → %s', (track, tab, orderId, expected) => {
    expect(urlFor(track, tab, orderId)).toBe(expected);
  });
});

describe('왕복', () => {
  /** 만든 주소를 다시 읽으면 같은 화면이어야 한다 — 여기가 어긋나면 새로고침이 튄다. */
  it.each([
    ['ln', 'fulfill', null],
    ['ln', 'request', null],
    ['onchain', 'fulfill', null],
    ['onchain', 'history', 'oc-1'],
    ['onchain', 'request', null],
  ] as const)('%s / %s / %s', (track, tab, orderId) => {
    const url = urlFor(track, tab, orderId);
    expect(parseRoute(url.replace('/', ''))).toEqual({ track, tab, orderId });
  });
});
