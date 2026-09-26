/**
 * 어드민이 보낸 보증금 인보이스
 *
 * **결제해야 진행된다** — 고객은 이걸 내야 의뢰가 등록되고, 후원자는 이걸
 * 내야 클레임이 성립한다. 여러 후원자가 동시에 받을 수 있고,
 * **먼저 결제한 쪽**이 가져간다.
 */
import { createStore, isBool, isNum, isStr, optional, recordOf, shape } from '@sajwo-tracker/shared';

export interface DepositInvoice {
  orderId: string;
  bolt11: string;
  receivedAt: number;
  /** 처리가 끝나 더 보여줄 필요가 없다 */
  done?: boolean;
}

type InvoiceMap = Record<string, DepositInvoice>;

const store = createStore<InvoiceMap>({}, {
  key: 'onchain:deposit-invoices',
  parse: recordOf(shape<DepositInvoice>({ orderId: isStr, bolt11: isStr, receivedAt: isNum, done: optional(isBool) })),
});

export const subscribeDepositInvoices = store.subscribe;
export const getDepositInvoicesSnapshot = store.get;

export function getDepositInvoice(orderId: string): DepositInvoice | undefined {
  const entry = store.get()[orderId];
  return entry && !entry.done ? entry : undefined;
}

export function putDepositInvoice(invoice: DepositInvoice): void {
  store.update(prev => ({ ...prev, [invoice.orderId]: { ...prev[invoice.orderId], ...invoice } }));
}

/** @testing-only */
export const _resetForTesting = store.reset;
