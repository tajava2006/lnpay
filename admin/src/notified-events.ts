/**
 * 알림 1회성 보장
 *
 * ── 왜 필요한가
 *
 * 릴레이는 어드민이 부팅할 때마다 **과거 이벤트를 전부 다시 보낸다.** 상태 전이
 * 핸들러는 `canTransition`이 막아줘서 재전송에 둔감하지만(이미 paid면 거부),
 * 상태를 바꾸지 않는 알림은 그런 방어가 없다. 그래서 어드민을 만질 때마다
 * 옛 주문의 "계좌 정보가 도착했습니다"가 계속 날아갔다.
 *
 * ── 왜 "캐치업 중엔 알림 끄기"가 아닌가
 *
 * 그게 더 간단하지만 틀린 경우가 생긴다. 어드민이 한 시간 꺼져 있는 동안 고객이
 * 계좌를 보냈다면, 그 이벤트는 다시 켤 때 캐치업으로 들어온다 — 진짜 알려야 할
 * 건인데 캐치업이라는 이유로 묻힌다.
 *
 * 이벤트 id로 기억하면 "언제 처음 봤든 한 번만"이 되어 둘 다 만족한다.
 */

const KEY = 'notified-events';

/**
 * 기억할 개수. 이벤트 id는 64자라 500개면 대략 35KB — localStorage에 부담이 없다.
 * 넘치면 오래된 것부터 버리는데, 그렇게까지 오래된 이벤트가 재전송돼도
 * 그때 알림이 한 번 더 가는 정도라 손해가 작다.
 */
const MAX = 500;

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * 이 이벤트로 알림을 보낼 권리를 주장한다.
 *
 * 처음 보는 이벤트면 기록하고 true, 이미 보낸 적이 있으면 false.
 * **알림을 보내기 직전에** 부르고 false면 조용히 건너뛴다.
 */
export function claimNotification(eventId: string): boolean {
  if (!eventId) return true; // id가 없으면 판단 불가 — 막지는 않는다

  const seen = load();
  if (seen.includes(eventId)) return false;

  seen.push(eventId);
  localStorage.setItem(KEY, JSON.stringify(seen.slice(-MAX)));
  return true;
}

/** 테스트용 초기화 */
export function _resetForTesting(): void {
  localStorage.removeItem(KEY);
}
