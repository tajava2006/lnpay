import { SimplePool } from 'nostr-tools/pool';
import { getSecretKey } from './keys';
import { getRelays } from './relays';
import { buildSajwoRequestEvent, signEvent } from './events';
import type { TrackedOrder } from '../shared/types';

export interface PublishResult {
  success: boolean;
  publishedTo: string[];
  errors: string[];
}

/**
 * TrackedOrder를 Nostr addressable event로 릴레이에 브로드캐스트한다.
 *
 * MV3 서비스워커 환경이므로 SimplePool은 매번 새로 생성한다.
 */
export async function publishOrder(order: TrackedOrder): Promise<PublishResult> {
  const [sk, relays] = await Promise.all([getSecretKey(), getRelays()]);

  const template = buildSajwoRequestEvent(order);
  const signedEvent = signEvent(template, sk);

  console.log('[Nostr] Publishing event:', signedEvent.id, 'to', relays);

  const pool = new SimplePool();
  const publishedTo: string[] = [];
  const errors: string[] = [];

  try {
    const promises = pool.publish(relays, signedEvent);
    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        publishedTo.push(result.value);
      } else {
        errors.push(String(result.reason));
      }
    }
  } finally {
    pool.destroy();
  }

  const success = publishedTo.length > 0;
  console.log('[Nostr] Published to', publishedTo.length, 'relays, errors:', errors.length);

  return { success, publishedTo, errors };
}
