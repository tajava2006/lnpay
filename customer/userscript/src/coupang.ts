/**
 * 쿠팡 주문 파싱
 *
 * customer-extension/src/shared/filter.ts + content/index.ts에서 이식.
 * 쿠팡 Next.js 페이지의 __NEXT_DATA__에서 buildId를 추출하고
 * JSON API를 호출하여 주문 데이터를 가져온다.
 */

// ── 쿠팡 API 타입 (최소 필요분) ────────────────────

interface CoupangNotPayedPayment {
  expirationDate: number;
  bankName: string;
  bankCode: string;
  accountNumber: string;
  depositor: string;
  depositPrice: number;
}

interface CoupangOrderData {
  pageProps: {
    domains: {
      order: {
        entity: {
          entities: Record<string, {
            orderId: number;
            title: string;
            orderedAt: number;
            totalProductPrice: number;
            allCanceled: boolean;
          }>;
        };
      };
      payment: {
        entities: Record<string, {
          orderId: number;
          mainPayType: string;
          totalPayedAmount: number;
          totalOrderAmount: number;
          totalCancelAmount: number;
          payed: boolean;
          notPayedPayment: CoupangNotPayedPayment | null;
        }>;
      };
    };
  };
}

export interface VirtualAccountInfo {
  bankName: string;
  bankCode: string;
  accountNumber: string;
  depositor: string;
  depositPrice: number;
  expirationDate: number;
}

// ── 헬퍼 ─────────────────────────────────────────────

const VIRTUAL_ACCOUNT_PAY_TYPE = 'VCNT';

function getOrderEntity(data: CoupangOrderData, orderId: string) {
  return data.pageProps?.domains?.order?.entity?.entities?.[orderId];
}

function getPaymentEntity(data: CoupangOrderData, orderId: string) {
  return data.pageProps?.domains?.payment?.entities?.[orderId];
}

// ── 공개 API ─────────────────────────────────────────

/** URL에서 orderId 추출 */
export function extractOrderIdFromUrl(): string | null {
  const match = window.location.pathname.match(/\/order\/(\d+)/);
  return match?.[1] ?? null;
}

/** __NEXT_DATA__ 스크립트가 나타날 때까지 대기 */
async function waitForNextData(maxAttempts = 20, interval = 100): Promise<HTMLElement | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const script = document.getElementById('__NEXT_DATA__');
    if (script) return script;
    await new Promise(r => setTimeout(r, interval));
  }
  return null;
}

/** 쿠팡 JSON API에서 주문 데이터를 가져온다 */
export async function fetchCoupangOrder(orderId: string): Promise<CoupangOrderData | null> {
  const nextDataScript = await waitForNextData();
  if (!nextDataScript) {
    console.warn('[사줘] __NEXT_DATA__ not found');
    return null;
  }

  let buildId: string;
  try {
    const nextData = JSON.parse(nextDataScript.textContent || '');
    buildId = nextData.buildId;
  } catch {
    console.error('[사줘] Failed to parse __NEXT_DATA__');
    return null;
  }

  const jsonUrl = `https://mc.coupang.com/ssr/_next/data/${buildId}/desktop/order/${orderId}.json?orderId=${orderId}`;

  try {
    const res = await fetch(jsonUrl, { credentials: 'include' });
    if (!res.ok) {
      console.error('[사줘] Fetch failed:', res.status);
      return null;
    }
    return await res.json() as CoupangOrderData;
  } catch (e) {
    console.error('[사줘] Fetch error:', e);
    return null;
  }
}

/** 무통장입금 미결제 주문인지 판별 */
export function isTargetOrder(data: CoupangOrderData, orderId: string): boolean {
  const payment = getPaymentEntity(data, orderId);
  if (!payment) return false;
  return payment.mainPayType === VIRTUAL_ACCOUNT_PAY_TYPE && !payment.payed;
}

/** 상품명 추출 */
export function extractProductName(data: CoupangOrderData, orderId: string): string {
  const order = getOrderEntity(data, orderId);
  return order?.title ?? '상품명 없음';
}

/** 무통장입금 계좌 정보 추출 */
export function extractVirtualAccount(data: CoupangOrderData, orderId: string): VirtualAccountInfo | null {
  const payment = getPaymentEntity(data, orderId);
  const notPayed = payment?.notPayedPayment;
  if (!notPayed) return null;

  return {
    bankName: notPayed.bankName,
    bankCode: notPayed.bankCode,
    accountNumber: notPayed.accountNumber,
    depositor: notPayed.depositor,
    depositPrice: notPayed.depositPrice,
    expirationDate: notPayed.expirationDate,
  };
}

/** 주문이 취소된 상태인지 확인 */
export function isCancelled(data: CoupangOrderData, orderId: string): boolean {
  const payment = getPaymentEntity(data, orderId);
  if (!payment) return false;
  return payment.totalCancelAmount > 0 && payment.totalCancelAmount === payment.totalOrderAmount;
}

/** 주문이 입금 완료 상태인지 확인 (취소된 주문도 payed===true이므로 취소 확인 우선) */
export function isPaid(data: CoupangOrderData, orderId: string): boolean {
  const payment = getPaymentEntity(data, orderId);
  if (!payment) return false;
  return payment.payed === true && !isCancelled(data, orderId);
}
