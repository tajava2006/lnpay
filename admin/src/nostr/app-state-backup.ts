/**
 * Admin 앱 상태 릴레이 백업 (범용)
 *
 * NIP-78 (kind 30078) addressable event에 NIP-44로 암호화해 저장한다.
 * escrow-backup.ts / ln-config.ts와 같은 패턴이되, d-tag만 다르게 주면
 * 어떤 상태든 실을 수 있게 일반화한 것이다.
 *
 * 왜 필요한가: Admin을 PC와 모바일 양쪽에서 번갈아 쓰려면 릴레이로 재구성할 수
 * 없는 로컬 전용 상태가 없어야 한다. 오더·요청은 릴레이 이벤트로 복원되고
 * 프리이미지와 LN 설정은 이미 NIP-78 백업이 있는데, **보증금 대기 상태와
 * 보증금 비율 설정만 로컬에 갇혀 있었다.**
 *
 * - 보증금 대기: A기기에서 인보이스를 발행하면 B기기는 그 사실을 모른다
 * - 보증금 비율: 기기마다 다르면 어느 기기가 주문을 받았느냐에 따라 동작이 갈린다
 *
 * 충돌 해결은 addressable event의 기본 규칙(같은 d-tag는 최신 created_at이 대체)을
 * 그대로 따른다 — 마지막 쓰기가 이긴다. Admin이 한 사람이라 이걸로 충분하다.
 *
 * escrow-backup.ts는 자금 경로라 굳이 이쪽으로 합치지 않고 그대로 둔다.
 */
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate } from 'nostr-tools/core';
import { APP_PUBKEY, CLIENT_TAG, getWriteRelays, storage } from '@sajwo-tracker/shared';
import { getSigner } from './nip46';

const APP_DATA_KIND = 30078;

/** d-tag 네임스페이스. 값이 바뀌면 기존 백업을 못 읽으니 함부로 고치지 않는다. */
export const BACKUP_TAGS = {
  pendingDeposits: `deposits:${CLIENT_TAG}`,
  settings: `settings:${CLIENT_TAG}`,
  /** Web Push VAPID 개인키 — 기기마다 따로 입력하지 않게 */
  vapid: `vapid:${CLIENT_TAG}`,
} as const;

/** 상태를 NIP-44로 암호화해 쓰기 릴레이에 발행한다. */
export async function publishAppState(dTag: string, data: unknown): Promise<void> {
  const signer = getSigner();
  if (!signer) throw new Error('app-state-backup: signer 없음');

  const ciphertext = await signer.nip44Encrypt(APP_PUBKEY, JSON.stringify(data));

  const template: EventTemplate = {
    kind: APP_DATA_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', dTag]],
    content: ciphertext,
  };
  const signed = await signer.signEvent(template);

  const writeRelays = await getWriteRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(writeRelays, signed));
    if (!results.some(r => r.status === 'fulfilled')) {
      throw new Error('모든 릴레이에 발행 실패');
    }
    console.log('[AppState] 발행:', dTag);
  } finally {
    pool.destroy();
  }
}

/** 쓰기 릴레이에서 상태를 조회해 복호화한다. 없거나 실패하면 null. */
export async function fetchAppState<T>(dTag: string): Promise<T | null> {
  return (await fetchAppStateResult<T>(dTag)).value;
}

/** 조회 결과. `known: false`는 **못 읽었다**는 뜻이지 없다는 뜻이 아니다. */
export interface AppStateResult<T> {
  known: boolean;
  value: T | null;
}

/**
 * 같은 조회를 하되 **"없다"와 "못 읽었다"를 구별한다.**
 *
 * `fetchAppState`는 둘을 `null` 하나로 뭉갠다. 백업 복원에는 그래도 된다 —
 * 없으면 로컬을 쓰면 그만이다. 하지만 **소유권 판정에는 치명적이다**:
 * 못 읽은 것을 "아무도 안 잡았다"로 읽으면 남이 쥔 소유권을 조용히
 * 빼앗는다(PLAN-ONCHAIN-TRACK §9.1).
 *
 * ⚠️ 구별에 한계가 있다. 릴레이가 **전부** 죽으면 `pool.get`이 예외가 아니라
 * `null`로 끝나므로 여기서도 "없음"으로 보인다. 그래서 소유권 주장은
 * 조회만으로 성립시키지 않고 **발행 성공까지** 확인한다 — 릴레이가 죽어
 * 있으면 그 발행이 실패하므로 빼앗기가 성립하지 않는다.
 */
export async function fetchAppStateResult<T>(dTag: string): Promise<AppStateResult<T>> {
  const signer = getSigner();
  if (!signer) return { known: false, value: null };

  const relays = await getWriteRelays(storage);
  const pool = new SimplePool();
  try {
    const event = await pool.get(relays, {
      kinds: [APP_DATA_KIND],
      authors: [APP_PUBKEY],
      '#d': [dTag],
    });
    if (!event) return { known: true, value: null };

    const plaintext = await signer.nip44Decrypt(APP_PUBKEY, event.content);
    return { known: true, value: JSON.parse(plaintext) as T };
  } catch (e) {
    console.warn('[AppState] 조회/복호화 실패:', dTag, e);
    return { known: false, value: null };
  } finally {
    pool.destroy();
  }
}
