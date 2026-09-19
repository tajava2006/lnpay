/**
 * 만료 값 부등식 사슬
 *
 * ── 이 파일이 막는 것과 못 막는 것
 *
 * **막는 것**: 누군가 상수 하나를 바꿔 사슬이 끊어지는 것. 개별 값은 다 그럴듯해
 * 보여도 서로의 관계가 깨지면 돈이 샌다. 상수는 리뷰에서 제일 안 읽히는 줄이라
 * 여기서 잡는 편이 낫다.
 *
 * **못 막는 것**: 실제 라이트닝 노드의 반응. mock이 'accepted'를 돌려준다고
 * 13,000블록짜리 CLTV를 진짜 채널이 받아준다는 뜻이 아니다. 오늘 F1(보증금 CLTV)은
 * 어떤 mock으로도 안 잡혔을 것이고, 실제로 코드를 읽다가 찾았다.
 *
 * 그러니 이건 울타리지 탐지기가 아니다. 탐지는 실행과 정독이 한다.
 *
 * ── 시계를 인자로 받으면 만료도 즉시 검증된다
 *
 * "만료 테스트는 몇 시간 기다려야 한다"는 대개 코드가 시계를 내부에서 읽기
 * 때문이다. `now`를 넘기면 그 문제가 사라진다. 여기 있는 건 전부 순수 함수다.
 */
import { describe, it, expect } from 'vitest';
import {
  ESCROW_WINDOW_MAX_SEC, escrowInvoiceExpiry,
  depositInvoiceParams, DEPOSIT_CLTV_MARGIN_SEC,
} from '../escrow-window';

const HOUR = 3600;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000;

/** 코드 곳곳에 흩어져 있는 값들. 바뀌면 여기도 같이 바뀌어야 한다. */
const SETTLE_SAFETY_MARGIN = 10 * 60;        // invoice-watcher
const MIN_INVOICE_LIFETIME = 6 * HOUR;       // service.ts (후원자 인보이스 하한)
const DISPUTE_MARGIN = 48 * HOUR;            // approveOrder (에스크로 CLTV 여유)
const DEPOSIT_CLTV_MARGIN = DEPOSIT_CLTV_MARGIN_SEC;  // 프로덕션 상수를 그대로 쓴다
const MAX_ORDER_EXPIRY = 90 * DAY;           // OrderForm의 제일 긴 선택지
/** LND 기본 max_cltv_expiry. 이걸 넘는 인보이스는 결제가 불가능하다. */
const CHANNEL_CLTV_LIMIT = 2016;

const toBlocks = (sec: number) => Math.ceil(sec / 600);

describe('사슬 ① 에스크로 안에서', () => {
  it('선제 settle 마진 < 에스크로 창', () => {
    // 마진이 창보다 크면 인보이스가 생기자마자 "곧 만료"로 판정돼 즉시 settle된다.
    expect(SETTLE_SAFETY_MARGIN).toBeLessThan(ESCROW_WINDOW_MAX_SEC);
  });

  it('후원자 인보이스 하한 < 에스크로 창', () => {
    // 하한이 창보다 길면 어떤 인보이스도 통과할 수 없다 — 거래가 아예 못 끝난다.
    expect(MIN_INVOICE_LIFETIME).toBeLessThan(ESCROW_WINDOW_MAX_SEC);
  });
});

describe('사슬 ② CLTV가 채널 상한 안에', () => {
  /**
   * 오늘 두 번 물린 자리다. 에스크로는 고쳤고 보증금은 빠뜨렸다가 감사에서 잡았다.
   * 둘 다 "의뢰 만료를 그대로 CLTV로 쓴다"가 원인이었다.
   */
  it('에스크로 CLTV — 제일 긴 의뢰에서도 안전', () => {
    const expiry = escrowInvoiceExpiry(NOW + MAX_ORDER_EXPIRY, NOW);
    expect(toBlocks(expiry + DISPUTE_MARGIN)).toBeLessThan(CHANNEL_CLTV_LIMIT);
  });

  /**
   * ⚠️ 이 테스트는 **한 번 거짓으로 통과했다.**
   *
   * 예전 판은 여기서 `escrowInvoiceExpiry`를 불렀다. 그런데 **프로덕션 보증금
   * 경로는 그 함수를 안 쓴다** — `request.expiration - now`를 그대로 CLTV로 썼다.
   * 즉 테스트가 코드가 아니라 "코드가 했어야 할 일"을 검증해서, 버그가 살아 있는
   * 채로 green이었다(2026-09-19 발견).
   *
   * 그래서 지금은 **프로덕션이 실제로 부르는 `depositInvoiceExpiry`** 를 부른다.
   * 이 import가 service.ts의 것과 갈리면 테스트가 다시 거짓말을 시작한다.
   */
  it('보증금 CLTV — 제일 긴 의뢰에서도 안전', () => {
    // 보증금이 꺼져 있어 지금은 안 도는 경로지만, 켜는 순간 이 값이 쓰인다.
    // "꺼져 있어서 안 터진다"에 기대면 켤 때 터진다.
    // CLTV를 여기서 다시 계산하지 않는다 — 프로덕션이 내놓는 값을 그대로 본다.
    expect(depositInvoiceParams(NOW + MAX_ORDER_EXPIRY, NOW).cltvBlocks)
      .toBeLessThan(CHANNEL_CLTV_LIMIT);
  });

  it.each([1, 3, 7, 30, 90])('%d일 의뢰의 보증금 CLTV가 상한 이하', days => {
    // 상한이 걸리기 전엔 30일(4464블록)·90일(13104블록)이 2016을 넘었다.
    expect(depositInvoiceParams(NOW + days * 24 * HOUR, NOW).cltvBlocks)
      .toBeLessThan(CHANNEL_CLTV_LIMIT);
  });

  it('상한을 안 걸면 장기 의뢰가 상한을 넘는다 — 상한이 필요한 이유', () => {
    // 이게 깨지면 상한 없이도 되는 세상이 온 것이고, 그때 구조를 다시 본다.
    expect(toBlocks(MAX_ORDER_EXPIRY + DEPOSIT_CLTV_MARGIN)).toBeGreaterThan(CHANNEL_CLTV_LIMIT);
  });

  it('의뢰 만료를 그대로 쓰면 상한을 넘는다 — 상한이 필요한 이유', () => {
    // 이 단언이 깨진다면 상한 없이도 되는 세상이 온 것이고, 그때 구조를 다시 본다.
    expect(toBlocks(MAX_ORDER_EXPIRY + DISPUTE_MARGIN)).toBeGreaterThan(CHANNEL_CLTV_LIMIT);
  });
});

describe('사슬 ③ 의뢰 길이와 무관하게 에스크로는 짧다', () => {
  it.each([1, 3, 7, 30, 90])('%d일짜리 의뢰도 에스크로는 상한 이하', days => {
    expect(escrowInvoiceExpiry(NOW + days * DAY, NOW)).toBeLessThanOrEqual(ESCROW_WINDOW_MAX_SEC);
  });

  it('짧은 의뢰는 의뢰 만료를 넘지 않는다', () => {
    // 의뢰가 끝난 뒤까지 살아 있는 에스크로는 의미가 없다.
    expect(escrowInvoiceExpiry(NOW + 2 * HOUR, NOW)).toBe(2 * HOUR);
  });
});
