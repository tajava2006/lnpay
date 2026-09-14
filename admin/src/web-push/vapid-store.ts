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
import { publishAppState, fetchAppState, BACKUP_TAGS } from '../nostr/app-state-backup';

const KEY = 'vapid-private-key';

/** base64url 43자(32바이트)인지 본다. 오타를 조용히 넘기지 않으려는 것. */
export function isValidVapidPrivateKey(d: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(d.trim());
}

export function getVapidPrivateKey(): string | null {
  return localStorage.getItem(KEY);
}

/** 로컬에 저장하고 릴레이 백업에도 올린다. 백업 실패는 저장을 막지 않는다. */
export async function setVapidPrivateKey(d: string): Promise<void> {
  const trimmed = d.trim();
  if (!isValidVapidPrivateKey(trimmed)) {
    throw new Error('VAPID 개인키 형식이 아닙니다 (base64url 43자).');
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
  if (backup?.d && isValidVapidPrivateKey(backup.d)) {
    localStorage.setItem(KEY, backup.d);
    console.log('[Push] VAPID 키를 릴레이 백업에서 복원');
  }
}
