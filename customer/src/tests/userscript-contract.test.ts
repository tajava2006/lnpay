/**
 * 유저스크립트 ↔ 웹앱 계약 + 쿠팡 응답 해석
 *
 * 유저스크립트가 쿠팡 응답에서 만든 값을 웹앱이 **받아야** 한다. 받는 쪽 확인(`isParsedOrderPayload`)과 보내는 쪽
 * 빌더(`buildParsedPayload`)가 갈리면 감지된 주문이 조용히 사라진다 — 둘을 여기서 같이 돌린다.
 *
 * 쿠팡 응답은 실제 캡처가 아니라 우리가 기대는 칸만 채운 모양이다(타입 `CoupangOrderData`). 쿠팡이 모양을 바꾸면
 * 여기가 아니라 실사용에서 드러난다 — 그때 `shape-changed`가 화면에 알린다.
 */
import { describe, expect, it } from 'vitest';
import {
  buildParsedPayload, isCancelled, isPaid, type CoupangOrderData,
} from '../../userscript/src/coupang';
import { pickNsec } from '../../userscript/src/storage';
import { keyCheckCode } from '../../userscript/src/nostr';
import { isParsedOrderPayload } from '../buyer/types';
import { checkCode } from '@sajwo-tracker/shared';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';

const ORDER_ID = '31000123456789';

type Payment = CoupangOrderData['pageProps']['domains']['payment']['entities'][string];

function coupang(payment: Partial<Payment> = {}, notPayed: Record<string, unknown> | null = {}): CoupangOrderData {
  const base: Payment = {
    orderId: Number(ORDER_ID),
    mainPayType: 'VCNT',
    totalPayedAmount: 0,
    totalOrderAmount: 32_900,
    totalCancelAmount: 0,
    payed: false,
    notPayedPayment: null,
  };
  const account = notPayed === null ? null : {
    expirationDate: 1_790_400_000_000, bankName: '국민은행', bankCode: '004', accountNumber: '123-456-789',
    depositor: '쿠팡(주)', depositPrice: 32_900, ...notPayed,
  };
  return {
    pageProps: {
      domains: {
        order: { entity: { entities: { [ORDER_ID]: {
          orderId: Number(ORDER_ID), title: '기계식 키보드', orderedAt: 1, totalProductPrice: 32_900, allCanceled: false,
        } } } },
        payment: { entities: { [ORDER_ID]: { ...base, notPayedPayment: account as Payment['notPayedPayment'], ...payment } } },
      },
    },
  };
}

describe('계약 — 유저스크립트가 만든 값을 웹앱이 받는다', () => {
  it('무통장 미결제 주문은 일곱 칸이 다 찬 값이 되고, 웹앱의 받는 확인을 통과한다', () => {
    const r = buildParsedPayload(coupang(), ORDER_ID);
    expect(r.kind).toBe('order');
    if (r.kind !== 'order') return;
    expect(r.payload).toEqual({
      coupangOrderId: ORDER_ID, productName: '기계식 키보드', price: 32_900, bankName: '국민은행',
      accountNumber: '123-456-789', depositor: '쿠팡(주)', expirationDate: 1_790_400_000_000,
    });
    expect(isParsedOrderPayload(r.payload)).toBe(true);
  });
});

describe('대상이 아닌 주문', () => {
  it('이미 입금했거나 카드 결제면 할 일이 없다', () => {
    expect(buildParsedPayload(coupang({ payed: true }), ORDER_ID).kind).toBe('not-target');
    expect(buildParsedPayload(coupang({ mainPayType: 'CARD' }), ORDER_ID).kind).toBe('not-target');
    expect(buildParsedPayload(coupang(), '999').kind).toBe('not-target');
  });
});

/** 칸이 빈 채로 보내면 웹앱이 버린다 — 보내지 않고 화면에 알린다 */
describe('쿠팡 응답 모양이 바뀌었을 때', () => {
  it.each([
    ['계좌 정보가 통째로 없다', coupang({}, null)],
    ['은행 이름이 없다', coupang({}, { bankName: null })],
    ['계좌번호가 빈 문자열', coupang({}, { accountNumber: ' ' })],
    ['금액이 문자열로 온다', coupang({}, { depositPrice: '32900' })],
    ['금액이 0', coupang({}, { depositPrice: 0 })],
    ['입금 기한이 없다', coupang({}, { expirationDate: undefined })],
  ])('%s → shape-changed', (_, data) => {
    expect(buildParsedPayload(data, ORDER_ID).kind).toBe('shape-changed');
  });
});

describe('입금·취소 판정', () => {
  it('취소는 전액 취소일 때만 — 취소된 주문도 payed가 true라 취소를 먼저 본다', () => {
    const cancelled = coupang({ payed: true, totalCancelAmount: 32_900 });
    expect(isCancelled(cancelled, ORDER_ID)).toBe(true);
    expect(isPaid(cancelled, ORDER_ID)).toBe(false);
  });

  it('부분 취소는 취소가 아니다', () => {
    expect(isCancelled(coupang({ payed: true, totalCancelAmount: 1_000 }), ORDER_ID)).toBe(false);
  });

  it('입금 완료', () => {
    expect(isPaid(coupang({ payed: true }), ORDER_ID)).toBe(true);
    expect(isPaid(coupang(), ORDER_ID)).toBe(false);
  });
});

/**
 * 스크립트가 쓰는 키 = 앱의 키여야 한다. 어긋나면 릴레이는 받아 주고 앱은 못 받아 감지된 주문이 조용히 사라진다
 * (2026-10-31 실측). 저장값이 덮어 붙여넣은 새 키를 이기던 게 원인이었다.
 */
describe('키 — 붙여넣은 키가 저장된 키를 이긴다', () => {
  const OLD = nsecEncode(generateSecretKey());
  const NEW = nsecEncode(generateSecretKey());
  const PLACEHOLDER = '%%NSEC_PLACEHOLDER%%';

  it('앱에서 키를 바꾸고 코드를 덮어 붙여넣으면 새 키로 바뀐다 (옛 이력을 비우라는 신호와 함께)', () => {
    expect(pickNsec(OLD, NEW)).toEqual({ nsec: NEW, replaced: true });
  });

  it('처음 설치는 붙여넣은 키 — 바꾼 게 아니다', () => {
    expect(pickNsec(null, NEW)).toEqual({ nsec: NEW, replaced: false });
  });

  it('같은 코드를 다시 붙여넣어도 바꾼 게 아니다', () => {
    expect(pickNsec(NEW, NEW)).toEqual({ nsec: NEW, replaced: false });
  });

  it('자동 업데이트로 받은 코드(키 자리가 플레이스홀더)는 저장된 키를 쓴다', () => {
    expect(pickNsec(NEW, PLACEHOLDER)).toEqual({ nsec: NEW, replaced: false });
    expect(pickNsec(null, PLACEHOLDER)).toEqual({ nsec: null, replaced: false });
  });

  it('쿠팡 쪽 알림의 확인 코드는 앱 안내의 확인 코드와 같은 모양이다', () => {
    const pubkey = getPublicKey(generateSecretKey());
    expect(keyCheckCode(pubkey)).toBe(checkCode(pubkey));
  });
});
