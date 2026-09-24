/**
 * 옛 프론트 어드민의 브라우저 저장소를 한 번 치운다 (PLAN-DAEMON 전환 뒤)
 *
 * 옛 어드민은 이 브라우저가 장부였다 — localStorage `admin:*`에 오더·에스크로·요청·보증금·알림·설정을, IndexedDB
 * `admin-history`에 모든 오더를 무기한 쌓았다. 지금은 데몬 DB가 장부고 이 앱은 `admin2:*` 캐시만 쓴다.
 * 옛 것은 아무도 읽지 않고 쓸 데도 없다(2026-09-24 운영자 확인 — 옛 거래는 전부 종결 또는 버린 테스트,
 * VAPID 키는 데몬 `vapid.key`로 따로 백업). 지금 로그인 세션 `admin:nip46`만 남긴다.
 */

const DONE_KEY = 'admin2:legacy-cleared';
const LEGACY_IDB = 'admin-history';
const LEGACY_PREFIX = 'admin:';
const KEEP_KEY = 'admin:nip46';
/** 접두사 없이 쓰던 옛 어드민 전용 키 */
const LEGACY_PLAIN_KEYS = [
  'auto-approve-enabled', 'notified-events', 'push-subscriptions', 'push-subscriptions-dead', 'vapid-private-key',
];

/** 지울 localStorage 키 */
export function legacyKeys(keys: readonly string[]): string[] {
  return keys.filter(k => (k.startsWith(LEGACY_PREFIX) && k !== KEEP_KEY) || LEGACY_PLAIN_KEYS.includes(k));
}

/** 부팅 때 한 번. 실패해도 앱은 뜬다 — 캐시 청소일 뿐이다 */
export function clearLegacyStorage(): void {
  try {
    if (localStorage.getItem(DONE_KEY)) return;
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
      .filter((k): k is string => k !== null);
    const doomed = legacyKeys(keys);
    for (const k of doomed) localStorage.removeItem(k);
    if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase(LEGACY_IDB);
    localStorage.setItem(DONE_KEY, String(Date.now()));
    if (doomed.length > 0) console.info('[옛 저장소] 지웠다', doomed);
  } catch (e) {
    console.warn('[옛 저장소] 못 치웠다', e);
  }
}
