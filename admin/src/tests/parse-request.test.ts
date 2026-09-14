/**
 * 요청 이벤트 파싱
 *
 * ── 왜 이 테스트가 생겼나
 *
 * `push-subscription`을 추가하면서 파서를 안 고쳤다. 파서는 맨 앞에서 `a` 태그가
 * 없으면 null을 반환하는데, 구독 등록은 계정 단위라 `a` 태그가 없는 게 정상이다.
 * 그래서 이벤트가 **파서 첫 줄에서 조용히 버려졌고**, 구독이 한 번도 저장되지
 * 않았다. 릴레이·암호화·전송이 다 정상이어도 발송할 대상이 비어 있으니
 * "알림이 안 온다"만 남았다.
 *
 * 실패가 로그 한 줄 없이 일어나는 종류라 — 파서가 null을 돌려주면 호출자는 그냥
 * return한다 — 눈으로는 절대 못 찾는다. 액션을 추가할 때마다 여기 한 줄씩 늘린다.
 */
import { describe, it, expect } from 'vitest';
import type { Event } from 'nostr-tools/core';
import { SAJWO_REQUEST_KIND, APP_PUBKEY } from '@sajwo-tracker/shared';
import { parseRequestEvent } from '../types';

const USER = 'user-pubkey-aaaa';

function event(tags: string[][], content = ''): Event {
  return {
    id: 'evt-1',
    pubkey: USER,
    created_at: 1_700_000_000,
    kind: 1111,
    tags,
    content,
    sig: 'sig',
  } as Event;
}

const aTag = ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:order-1`];

describe('parseRequestEvent', () => {
  describe('계정 단위 요청 — a 태그가 없어야 정상', () => {
    it('push-subscription을 a 태그 없이 파싱한다', () => {
      const parsed = parseRequestEvent(event([
        ['action', 'push-subscription'],
        ['p', APP_PUBKEY],
      ], 'nip44-ciphertext'));

      expect(parsed).not.toBeNull();
      expect(parsed!.action).toBe('push-subscription');
      expect(parsed!.pubkey).toBe(USER);
    });

    it('암호문을 raw로 넘겨준다 — 복호화는 핸들러 몫', () => {
      const parsed = parseRequestEvent(event([
        ['action', 'push-subscription'],
      ], 'nip44-ciphertext'));

      expect((parsed!.raw as { content: string }).content).toBe('nip44-ciphertext');
    });
  });

  describe('오더 단위 요청 — a 태그가 없으면 버린다', () => {
    it.each(['payment-confirm', 'cancel-request', 'remit-request', 'account-info'] as const)(
      '%s는 a 태그 없이는 null',
      action => {
        expect(parseRequestEvent(event([['action', action]]))).toBeNull();
      },
    );

    it('a 태그가 있으면 orderId를 뽑는다', () => {
      const parsed = parseRequestEvent(event([aTag, ['action', 'remit-request']]));

      expect(parsed!.orderId).toBe('order-1');
    });

    it('a 태그의 kind가 다르면 버린다', () => {
      const parsed = parseRequestEvent(event([
        ['a', `1:${APP_PUBKEY}:order-1`],
        ['action', 'remit-request'],
      ]));

      expect(parsed).toBeNull();
    });
  });

  describe('모르는 액션', () => {
    it('null을 돌려준다', () => {
      expect(parseRequestEvent(event([aTag, ['action', 'not-a-real-action']]))).toBeNull();
    });
  });
});
