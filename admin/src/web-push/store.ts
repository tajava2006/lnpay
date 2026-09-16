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

/**
 * 죽은 것으로 확인된 엔드포인트 묘비.
 *
 * 이게 없으면 되살아난다. 구독 등록 이벤트는 만료가 없어서 어드민이 부팅할 때마다
 * 릴레이가 **전부 다시 보내주는데**, 그중 이미 죽은 엔드포인트가 "처음 보는 것"으로
 * 잡혀 저장 → 환영 알림 → 410 → 삭제 → 다음 부팅에 또 처음 보는 것... 이 무한히 돈다.
 *
 * 푸시 서비스의 404/410은 영구적이다(엔드포인트는 재사용되지 않는다). 그래서 한 번
 * 죽은 건 영원히 죽은 것으로 취급해도 안전하다.
 */
const DEAD_KEY = 'push-subscriptions-dead';
const DEAD_MAX = 200;

/** pubkey → 구독 목록 */
type SubscriptionMap = Record<string, PushSubscriptionPayload[]>;

function loadDead(): string[] {
  try {
    const raw = localStorage.getItem(DEAD_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function markDead(endpoint: string): void {
  const list = loadDead().filter(e => e !== endpoint);
  list.push(endpoint);
  // 오래된 것부터 버린다. 무한히 쌓을 이유는 없다.
  localStorage.setItem(DEAD_KEY, JSON.stringify(list.slice(-DEAD_MAX)));
}

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

/**
 * 구독을 등록한다. 같은 엔드포인트면 갱신(키가 회전될 수 있다).
 *
 * **처음 보는 엔드포인트일 때만 true**를 반환한다. 호출자가 이걸로 환영 알림을
 * 한 번만 보낸다 — 어드민은 재부팅할 때마다 릴레이에서 같은 등록 이벤트를 다시
 * 받으므로, 저장할 때마다 보내면 어드민을 새로고침할 때마다 유저에게
 * "등록되었습니다"가 날아간다.
 */
export function saveSubscription(pubkey: string, sub: PushSubscriptionPayload): boolean {
  // 죽은 걸로 확인된 엔드포인트는 되살리지 않는다. 릴레이가 옛 등록 이벤트를
  // 계속 재전송하므로, 이 가드가 없으면 매 부팅마다 신규로 잡혀 알림이 나간다.
  if (loadDead().includes(sub.endpoint)) {
    return false;
  }

  const map = load();
  const list = map[pubkey] ?? [];
  const isNew = !list.some(s => s.endpoint === sub.endpoint);

  const next = list.filter(s => s.endpoint !== sub.endpoint);
  next.push(sub);
  map[pubkey] = next;
  save(map);

  console.log('[Push] 구독 저장:', pubkey.slice(0, 8), '— 총', next.length, '개', isNew ? '(신규)' : '(기존)');
  return isNew;
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
  markDead(endpoint);

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
  localStorage.removeItem(DEAD_KEY);
}
