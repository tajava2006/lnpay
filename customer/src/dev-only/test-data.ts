/**
 * [DEV ONLY] 테스트 주문 데이터 생성기
 *
 * 쿠팡 데이터 없이 테스트할 수 있도록 가짜 주문 데이터를 생성한다.
 * createOrder()에 전달 가능한 형식으로, content script와 동일한 저장 프로세스를 거친다.
 *
 * 이 파일은 import.meta.env.DEV 가드 내부에서만 import되며
 * 프로덕션 빌드에서 완전히 제거된다.
 */

import type { VirtualAccountInfo } from '../shared/types';

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const SAMPLE_PRODUCTS = [
  '삼성 갤럭시 S24 Ultra',
  'Apple 맥북 프로 14인치',
  'LG 올레드 TV 55인치',
  '다이슨 에어랩 멀티 스타일러',
  '나이키 에어맥스 97',
  '로지텍 MX Master 3S',
  '아이패드 프로 12.9인치',
  '소니 WH-1000XM5 헤드폰',
  '브리타 정수기 필터 세트',
  '쿠팡 로켓프레시 과일 모음',
];

const BANKS = [
  { name: '농협은행', code: 'BK11' },
  { name: '국민은행', code: 'BK04' },
  { name: '신한은행', code: 'BK88' },
  { name: '우리은행', code: 'BK20' },
  { name: '하나은행', code: 'BK81' },
];

export interface TestOrderParams {
  /** 주문 금액 (지정하지 않으면 1,000~100,000 랜덤) */
  price?: number;
  /** 만료까지 남은 시간 - 초 (지정하지 않으면 1~24시간 랜덤) */
  expirationSeconds?: number;
  /** 상품명 (지정하지 않으면 랜덤 선택) */
  productName?: string;
}

/**
 * createOrder()에 전달할 수 있는 테스트 주문 데이터를 생성한다.
 */
export function generateTestOrderData(params: TestOrderParams = {}) {
  const orderId = String(randomInt(1_000_000_000, 9_999_999_999));
  const price = params.price ?? randomInt(1_000, 100_000);
  const expSeconds = params.expirationSeconds ?? randomInt(3600, 86400);
  const productName =
    params.productName ?? SAMPLE_PRODUCTS[randomInt(0, SAMPLE_PRODUCTS.length - 1)]!;

  const bank = BANKS[randomInt(0, BANKS.length - 1)]!;

  const virtualAccount: VirtualAccountInfo = {
    bankName: bank.name,
    bankCode: bank.code,
    accountNumber: `${randomInt(100, 999)}-${randomInt(1000, 9999)}-${randomInt(1000, 9999)}-${randomInt(10, 99)}`,
    depositor: '쿠팡',
    depositPrice: price,
    expirationDate: Date.now() + expSeconds * 1000,
  };

  return {
    orderId,
    productName,
    amount: price,
    virtualAccount,
    orderedAt: Date.now(),
  };
}
