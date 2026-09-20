/**
 * 어드민이 보낸 보증금 인보이스
 *
 * **결제해야 진행된다** — 고객은 이걸 내야 의뢰가 등록되고, 후원자는 이걸
 * 내야 클레임이 성립한다(§4.1b). 여러 후원자가 동시에 받을 수 있고,
 * **먼저 결제한 쪽**이 가져간다.
 */
const STORAGE_KEY = 'onchain:deposit-invoices';

export interface DepositInvoice {
  orderId: string;
  bolt11: string;
  receivedAt: number;
  /** 처리가 끝나 더 보여줄 필요가 없다 */
  done?: boolean;
}

type InvoiceMap = Record<string, DepositInvoice>;
type Listener = () => void;

function load(): InvoiceMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as InvoiceMap) : {};
  } catch {
    return {};
  }
}

let invoices: InvoiceMap = load();
const listeners = new Set<Listener>();

export function subscribeDepositInvoices(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDepositInvoicesSnapshot(): InvoiceMap {
  return invoices;
}

export function getDepositInvoice(orderId: string): DepositInvoice | undefined {
  const entry = invoices[orderId];
  return entry && !entry.done ? entry : undefined;
}

export function putDepositInvoice(invoice: DepositInvoice): void {
  invoices = { ...invoices, [invoice.orderId]: { ...invoices[invoice.orderId], ...invoice } };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(invoices));
  for (const l of listeners) l();
}

/** @testing-only */
export function _resetForTesting(): void {
  invoices = {};
  localStorage.removeItem(STORAGE_KEY);
}
