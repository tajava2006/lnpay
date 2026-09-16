/**
 * VAPID 개인키 보관
 *
 * 공개키는 `shared/constants.ts`에 박혀 있고(공개 정보라 레포에 있어도 된다)
 * 개인키만 어드민이 1회 입력한다. 공개 레포에 커밋할 수 없기 때문이다.
 *
 * 개인키는 43자 base64url 한 줄이다 — 공개키를 이미 알고 있어서 JWK의 x·y를
 * 거기서 복원할 수 있고, 그래서 사람이 옮겨야 할 비밀이 `d` 하나로 줄었다.
 *
 * NIP-78 백업에 싣는다. 어드민을 PC와 모바일에서 번갈아 쓰는데 이 키가 한 기기에만
 * 있으면 다른 기기에서는 알림이 조용히 안 나간다 — 실패가 눈에 안 보이는 종류라
 * 특히 위험하다.
 *
 * 이 키가 유출되면 남이 우리 이름으로 우리 구독자에게 푸시를 쏠 수 있다.
 * 다만 **내용은 못 만든다** — 페이로드는 구독자 공개키로 암호화되고 그건 구독
 * 정보 안에 있지 이 키에 있지 않다. 유출 시 대응은 키쌍 교체인데, 그러면
 * 기존 구독이 전부 무효가 되어 유저가 알림을 다시 켜야 한다.
 */
import { VAPID_PUBLIC_KEY } from '@sajwo-tracker/shared';
import { publishAppState, fetchAppState, BACKUP_TAGS } from '../nostr/app-state-backup';
import { vapidKeyPairMatches } from './crypto';

const KEY = 'vapid-private-key';

/**
 * base64url 43자(32바이트)인지 본다. 버튼 활성화를 위한 **모양 검사일 뿐**이고,
 * 실제로 쓸 수 있는 키인지는 `vapidKeyPairMatches`가 판정한다.
 */
export function isValidVapidPrivateKey(d: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(d.trim());
}

export function getVapidPrivateKey(): string | null {
  return localStorage.getItem(KEY);
}

/**
 * 이미 저장돼 있는 키가 쓸 수 있는 키인지 확인한다. 부팅 시 1회.
 *
 * 짝 검증을 붙이기 전에 저장된 잘못된 키는 그대로 남아 있다. 그 상태로는
 * 파이어폭스에만 알림이 가고 크롬 계열은 403으로 조용히 죽는다 — 증상만 보면
 * 키를 의심할 이유가 없어서 엉뚱한 데를 파게 된다. 부팅 때 지워서 "푸시 키 필요"
 * 경고가 뜨게 하는 편이 훨씬 빨리 끝난다.
 */
export async function discardVapidKeyIfMismatched(): Promise<boolean> {
  const stored = getVapidPrivateKey();
  if (!stored) return false;
  if (await vapidKeyPairMatches(VAPID_PUBLIC_KEY, stored)) return false;

  localStorage.removeItem(KEY);
  console.warn('[Push] 저장된 VAPID 키가 공개키와 짝이 맞지 않아 폐기했습니다 — 다시 입력해 주세요.');
  return true;
}

/** 로컬에 저장하고 릴레이 백업에도 올린다. 백업 실패는 저장을 막지 않는다. */
export async function setVapidPrivateKey(d: string): Promise<void> {
  const trimmed = d.trim();
  if (!isValidVapidPrivateKey(trimmed)) {
    throw new Error('VAPID 개인키 형식이 아닙니다 (base64url 43자).');
  }
  // 형식만 맞고 짝이 아닌 키는 크롬 계열에서만 403으로 죽고 파이어폭스에서는
  // 멀쩡히 통과한다. 그 비대칭을 여기서 끊는다.
  if (!await vapidKeyPairMatches(VAPID_PUBLIC_KEY, trimmed)) {
    throw new Error('이 개인키는 앱의 VAPID 공개키와 짝이 맞지 않습니다. 키를 다시 확인해 주세요.');
  }
  localStorage.setItem(KEY, trimmed);

  try {
    await publishAppState(BACKUP_TAGS.vapid, { d: trimmed });
  } catch (e) {
    console.warn('[Push] VAPID 키 릴레이 백업 실패 — 이 기기에만 저장됨:', e);
  }
}

/**
 * 로컬에 없으면 릴레이 백업에서 복원한다. 어드민 부팅 시 1회 호출한다.
 * 다른 기기에서 입력한 키를 이 기기가 넘겨받는 경로다.
 */
export async function restoreVapidPrivateKey(): Promise<void> {
  if (getVapidPrivateKey()) return;

  const backup = await fetchAppState<{ d: string }>(BACKUP_TAGS.vapid);
  if (!backup?.d || !isValidVapidPrivateKey(backup.d)) return;

  // 백업에 잘못된 키가 들어 있을 수 있다(짝 검증을 붙이기 전에 저장된 것).
  // 그대로 가져오면 이 기기도 같은 증상을 물려받는다.
  if (!await vapidKeyPairMatches(VAPID_PUBLIC_KEY, backup.d)) {
    console.warn('[Push] 릴레이 백업의 VAPID 키가 공개키와 짝이 맞지 않음 — 복원하지 않음');
    return;
  }

  localStorage.setItem(KEY, backup.d);
  console.log('[Push] VAPID 키를 릴레이 백업에서 복원');
}
