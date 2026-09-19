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
import { SAJWO_REQUEST_KIND, APP_PUBKEY, REQUEST_ACTIONS } from '@sajwo-tracker/shared';
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

  /**
   * ── 이 블록이 제일 중요하다 ──
   *
   * 새 액션을 추가하면서 파서를 빠뜨리는 실수를 **두 번** 했다.
   *
   *   2026-09-16  push-subscription — a 태그 검사에 걸려 통째로 버려짐
   *   2026-09-19  sponsor-invoice   — switch의 default로 떨어져 "Unknown action"
   *
   * 둘 다 증상이 똑같았다. 발행은 되는데 어드민이 아무 반응이 없고, 유저는
   * 자기가 뭘 잘못했는지 알 수 없다. 타입 검사로는 절대 안 잡힌다 —
   * 파서의 switch는 문자열 비교라 케이스가 빠져도 컴파일된다.
   *
   * 그래서 **모든 액션을 전수로 돈다.** 새 액션을 추가하면 여기서 결정을
   * 강제당한다: 파싱하도록 케이스를 넣든지, 안 하는 이유를 여기 적든지.
   */
  describe('전수 — 모든 액션이 처리되거나, 안 하는 이유가 적혀 있다', () => {
    /** 어드민 파서가 일부러 다루지 않는 액션과 그 이유 */
    const NOT_FOR_ADMIN: Record<string, string> = {
      'coupang-status': '유저스크립트 → 고객 자기 자신. p=APP_PUBKEY가 아니라 어드민에 도달하지 않는다',
    };

    /** 액션별로 파싱에 필요한 최소 태그 */
    const EXTRA_TAGS: Record<string, string[][]> = {
      'sponsor-invoice': [['bolt11', 'lnbc1...']],
    };

    it.each(Object.values(REQUEST_ACTIONS))('%s', action => {
      const reason = NOT_FOR_ADMIN[action];
      const tags = [aTag, ['action', action], ...(EXTRA_TAGS[action] ?? [])];
      const parsed = parseRequestEvent(event(tags));

      if (reason) {
        expect(parsed, `제외 사유: ${reason}`).toBeNull();
      } else {
        expect(parsed, `${action}이 파서에서 버려진다 — switch에 케이스가 있는지 확인`).not.toBeNull();
        expect(parsed!.action).toBe(action);
      }
    });
  });

  describe('sponsor-invoice', () => {
    it('bolt11을 꺼내 담는다 — 지급처가 본문이다', () => {
      const parsed = parseRequestEvent(event([
        aTag, ['action', 'sponsor-invoice'], ['bolt11', 'lnbc-payout'],
      ]));

      expect(parsed).toMatchObject({ action: 'sponsor-invoice', bolt11: 'lnbc-payout' });
    });

    it('bolt11이 없으면 버린다 — 내용 없는 등록은 의미가 없다', () => {
      expect(parseRequestEvent(event([aTag, ['action', 'sponsor-invoice']]))).toBeNull();
    });
  });
});
