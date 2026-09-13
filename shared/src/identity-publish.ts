/**
 * 유저 키의 공개 신원 발행 (kind 0 프로필 + kind 10002 릴레이 목록)
 *
 * ── 왜 필요한가
 *
 * 유저가 이 키로 아무 nostr 클라이언트에 로그인하면 거래 알림을 받을 수 있다.
 * 그런데 그게 성립하려면 두 가지가 있어야 한다:
 *
 * **kind 10002 (인박스)** — 클라이언트가 "나에게 온 것"을 찾는 방식은 내 10002의
 * read 릴레이를 구독하는 것이다. 이게 없으면 클라이언트는 자기 기본 릴레이 셋을
 * 뒤지는데, 거기 우리 릴레이가 없으면 어드민이 보낸 알림을 영영 못 본다.
 * 그래서 어드민과 같은 릴레이 구성으로 하나 발행해 둔다.
 *
 * **kind 0 (프로필)** — 없으면 클라이언트에 정체불명의 npub으로만 보인다.
 * Amethyst는 알림을 받을 계정을 따로 고르게 하는데, 그때 이름이 없으면 이게
 * 무슨 키인지 알 수 없다. 이름을 붙여두면 "아, 이걸로 받아야겠구나"가 바로 읽힌다.
 *
 * ── 한 번만, 조용히
 *
 * 키 생성 직후 1회만 발행하고 로컬에 표시를 남긴다. 실패해도 앱 동작을 막지 않는다 —
 * 알림은 부가 기능이고, 못 받는다고 거래가 안 되는 것은 아니다.
 */
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { getReadRelays } from './relays';
import type { StorageAdapter } from './types';

const PUBLISHED_KEY = 'nostr:identity-published';

/**
 * 프로필 이름. npub 앞자리를 붙여 여러 기기·여러 키를 쓸 때 구분되게 한다.
 * 사람 이름처럼 보이지 않게 용도를 앞에 박아둔다 — 이건 신원이 아니라 알림 수신함이다.
 */
function displayName(pubkey: string): string {
  return `PairBuy user · ${pubkey.slice(0, 8)}`;
}

const PROFILE_ABOUT =
  '페어바이(PairBuy) 거래 알림 수신용 임시 계정입니다. '
  + '브라우저가 만들어 브라우저에 보관하는 키라 일반적인 nostr 신원으로는 쓰지 마세요.';

/**
 * 아직 발행한 적이 없으면 kind 0 + kind 10002를 발행한다.
 * 이미 했으면 아무것도 하지 않는다.
 */
export async function ensureIdentityPublished(
  storage: StorageAdapter,
  secretKey: Uint8Array,
): Promise<void> {
  const done = await storage.get<boolean>(PUBLISHED_KEY);
  if (done) return;

  const pubkey = getPublicKey(secretKey);
  const relays = await getReadRelays(storage);
  if (relays.length === 0) return; // 릴레이를 모르면 다음 기회에

  const createdAt = Math.floor(Date.now() / 1000);

  const profile = finalizeEvent({
    kind: 0,
    created_at: createdAt,
    tags: [],
    content: JSON.stringify({
      name: displayName(pubkey),
      about: PROFILE_ABOUT,
    }),
  }, secretKey);

  // 어드민과 같은 릴레이를 읽기·쓰기 양쪽으로 선언한다.
  // 알림이 오가는 곳이 거기뿐이라 나눌 이유가 없다.
  const relayList = finalizeEvent({
    kind: 10002,
    created_at: createdAt,
    tags: relays.map(url => ['r', url]),
    content: '',
  }, secretKey);

  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled([
      ...pool.publish(relays, profile),
      ...pool.publish(relays, relayList),
    ]);
    if (!results.some(r => r.status === 'fulfilled')) {
      console.warn('[Identity] 신원 이벤트 발행 실패 — 다음 실행에서 재시도');
      return;
    }
    await storage.set(PUBLISHED_KEY, true);
    console.log('[Identity] kind 0 + 10002 발행 완료:', pubkey.slice(0, 8));
  } catch (err) {
    console.warn('[Identity] 신원 이벤트 발행 중 오류:', err);
  } finally {
    pool.destroy();
  }
}
