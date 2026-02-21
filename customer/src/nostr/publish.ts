import { SimplePool } from 'nostr-tools/pool';
import { getSecretKey, getReadRelays, type RequestAction } from '@sajwo-tracker/shared';
import { storage } from './storage';
import { buildRequestEvent, signEvent } from './events';
import type { TrackedOrder } from '../shared/types';

export interface RequestResult {
  success: boolean;
  publishedTo: string[];
  errors: string[];
  /** 발행된 서명 이벤트 원본 (JSON 직렬화) */
  raw?: string;
}

/**
 * TrackedOrder에 대한 kind 1111 요청을 릴레이에 브로드캐스트한다.
 *
 * MV3 서비스워커 환경이므로 SimplePool은 매번 새로 생성한다.
 */
export async function sendRequest(order: TrackedOrder, action: RequestAction): Promise<RequestResult> {
  const [sk, relays] = await Promise.all([getSecretKey(storage), getReadRelays(storage)]);

  const template = buildRequestEvent(order, action);
  const signedEvent = signEvent(template, sk);

  console.log('[Nostr] Publishing request:', signedEvent.id, 'action:', action, 'to', relays);

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

  return {
    success,
    publishedTo,
    errors,
    raw: success ? JSON.stringify(signedEvent) : undefined,
  };
}
