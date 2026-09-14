/**
 * 구독 저장소
 *
 * 유저 pubkey 하나당 구독 여러 개를 둔다 — 한 사람이 PC와 폰 양쪽에서 쓰면
 * 브라우저마다 별도 구독이 생기고, 둘 다 살아 있어야 어디서든 알림을 받는다.
 * 엔드포인트가 구독의 신원이라 같은 엔드포인트가 다시 오면 갱신한다.
 *
 * 어드민 기기 간 동기화는 저절로 된다: 구독 등록이 릴레이의 kind 1111로 오고
 * 어드민 기기 전부가 그걸 받아 각자 저장한다. 그래서 NIP-78 백업이 따로 필요 없다.
 */
import type { PushSubscriptionPayload } from './types';

const KEY = 'push-subscriptions';

/** pubkey → 구독 목록 */
type SubscriptionMap = Record<string, PushSubscriptionPayload[]>;

function load(): SubscriptionMap {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SubscriptionMap) : {};
  } catch {
    return {};
  }
}

function save(map: SubscriptionMap): void {
  localStorage.setItem(KEY, JSON.stringify(map));
}

/** 구독을 등록한다. 같은 엔드포인트면 갱신(키가 회전될 수 있다). */
export function saveSubscription(pubkey: string, sub: PushSubscriptionPayload): void {
  const map = load();
  const list = map[pubkey] ?? [];
  const next = list.filter(s => s.endpoint !== sub.endpoint);
  next.push(sub);
  map[pubkey] = next;
  save(map);
  console.log('[Push] 구독 저장:', pubkey.slice(0, 8), '— 총', next.length, '개');
}

export function getSubscriptions(pubkey: string): PushSubscriptionPayload[] {
  return load()[pubkey] ?? [];
}

/**
 * 죽은 구독을 지운다.
 *
 * 유저가 브라우저 데이터를 지우거나 알림을 끄면 엔드포인트가 404/410으로 죽는다.
 * 그대로 두면 발송 때마다 헛 요청이 나가므로 그때 정리한다.
 */
export function removeSubscription(pubkey: string, endpoint: string): void {
  const map = load();
  const list = map[pubkey];
  if (!list) return;
  const next = list.filter(s => s.endpoint !== endpoint);
  if (next.length === 0) delete map[pubkey];
  else map[pubkey] = next;
  save(map);
  console.log('[Push] 죽은 구독 제거:', pubkey.slice(0, 8));
}

/** 테스트용 초기화 */
export function _resetForTesting(): void {
  localStorage.removeItem(KEY);
}
