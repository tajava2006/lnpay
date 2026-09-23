/**
 * 어드민이 "이건 처리 못 한다"고 알려온 것 (주문별 마지막 한 건)
 *
 * 의뢰 등록 거절은 `pending-request-store`가 받는다. 여기는 **오더가 생긴 뒤**의
 * 거절이다 — 클레임(주소·수수료율 불량), 늦은 사전서명, 늦은 계좌, 늦은 송금 주장.
 * 전에는 이 경로들이 콘솔에만 남아서 유저는 "보냈는데 아무 일도 없다"만 봤다(리뷰 #8).
 */
const STORAGE_KEY = 'onchain:notices';

export interface OrderNotice {
  orderId: string;
  reason: string;
  receivedAt: number;
}

type NoticeMap = Record<string, OrderNotice>;
type Listener = () => void;

function load(): NoticeMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as NoticeMap) : {};
  } catch {
    return {};
  }
}

let notices: NoticeMap = load();
const listeners = new Set<Listener>();

export function subscribeNotices(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNoticesSnapshot(): NoticeMap {
  return notices;
}

export function putNotice(notice: OrderNotice): void {
  const existing = notices[notice.orderId];
  if (existing && existing.receivedAt > notice.receivedAt) return;
  notices = { ...notices, [notice.orderId]: notice };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notices));
  for (const l of listeners) l();
}

export function clearNotice(orderId: string): void {
  if (!notices[orderId]) return;
  const { [orderId]: _gone, ...rest } = notices;
  notices = rest;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notices));
  for (const l of listeners) l();
}

/** @testing-only */
export function _resetForTesting(): void {
  notices = {};
  localStorage.removeItem(STORAGE_KEY);
}
