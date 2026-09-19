/**
 * 에스크로 창
 *
 * 의뢰 수명과 홀드 인보이스 수명을 분리한 뒤로, 이 둘이 다시 엉키면
 * **후원자가 원화를 보냈는데 HTLC가 타임아웃으로 환불되는** 최악의 결말이 난다.
 * 두 함수가 같은 상수를 보고 같은 시각을 가리키는지 고정한다.
 */
import { describe, it, expect } from 'vitest';
import {
  ESCROW_WINDOW_MAX_SEC, escrowInvoiceExpiry, escrowDeadline,
} from '../escrow-window';

const NOW = 1_700_000_000;
const HOUR = 3600;
const DAY = 24 * HOUR;

describe('escrowInvoiceExpiry — 인보이스에 줄 유효시간', () => {
  it('장기 의뢰는 상한으로 자른다', () => {
    // 한 달짜리 의뢰. 자르지 않으면 CLTV가 채널 상한(보통 2016블록)을 넘어
    // 인보이스가 아예 안 만들어진다.
    expect(escrowInvoiceExpiry(NOW + 30 * DAY, NOW)).toBe(ESCROW_WINDOW_MAX_SEC);
  });

  it('의뢰 만료가 더 가까우면 그쪽을 따른다', () => {
    // 의뢰가 끝난 뒤까지 살아 있는 에스크로는 의미가 없다.
    expect(escrowInvoiceExpiry(NOW + 3 * HOUR, NOW)).toBe(3 * HOUR);
  });

  it('이미 만료된 의뢰는 0 이하 — 호출자가 승인을 막는다', () => {
    expect(escrowInvoiceExpiry(NOW - 1, NOW)).toBeLessThanOrEqual(0);
  });

  it('CLTV가 채널 상한 안에 들어온다', () => {
    // approveOrder: cltv = ceil((expiry + 48h) / 600)
    const expiry = escrowInvoiceExpiry(NOW + 365 * DAY, NOW);
    const cltvBlocks = Math.ceil((expiry + 48 * HOUR) / 600);

    // LND 기본 max_cltv_expiry = 2016블록
    expect(cltvBlocks).toBeLessThan(2016);
  });
});

describe('escrowDeadline — 안전망이 봐야 할 시각', () => {
  it('장기 의뢰에서는 의뢰 만료가 아니라 인보이스 만료를 가리킨다', () => {
    const created = NOW;
    const orderExpiration = NOW + 30 * DAY;

    // 의뢰 만료(30일 뒤)를 보면 선제 settle이 영영 안 돈다.
    expect(escrowDeadline(orderExpiration, created)).toBe(created + ESCROW_WINDOW_MAX_SEC);
  });

  it('짧은 의뢰에서는 의뢰 만료를 그대로 쓴다 — 기존 동작 유지', () => {
    // 상한 도입 이전에 만들어진 엔트리도 이 식으로 맞는다.
    // 예전 의뢰는 만료가 24시간 이내였으므로 min이 의뢰 만료를 고른다.
    const created = NOW;
    const orderExpiration = NOW + 6 * HOUR;

    expect(escrowDeadline(orderExpiration, created)).toBe(orderExpiration);
  });

  it('발행 시각과 안전망이 같은 시각을 가리킨다', () => {
    // 두 함수가 어긋나면 인보이스가 죽은 뒤에 settle을 시도하거나,
    // 살아 있는데 미리 잘라버린다.
    const orderExpiration = NOW + 30 * DAY;
    const expiry = escrowInvoiceExpiry(orderExpiration, NOW);

    expect(escrowDeadline(orderExpiration, NOW)).toBe(NOW + expiry);
  });
});
