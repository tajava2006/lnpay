/**
 * 구독 저장소
 *
 * 여기서 지키는 건 "신규인가"의 판정이다. 어드민은 새로고침할 때마다 릴레이에서
 * 같은 등록 이벤트를 다시 받는데, 그때마다 신규로 보면 유저에게 "알림이
 * 등록되었습니다"가 반복해서 날아간다. 알림 기능이 스팸이 되는 가장 빠른 길이라
 * 이 판정만큼은 고정해 둔다.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveSubscription,
  getSubscriptions,
  removeSubscription,
  _resetForTesting,
} from '../web-push/store';
import type { PushSubscriptionPayload } from '../web-push/types';

const USER = 'user-pubkey-aaaa';
const OTHER = 'user-pubkey-bbbb';

function sub(endpoint: string, auth = 'auth-1'): PushSubscriptionPayload {
  return { endpoint, p256dh: 'p256dh-1', auth };
}

describe('구독 저장소', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe('신규 판정 — 환영 알림이 여기 달려 있다', () => {
    it('처음 보는 엔드포인트면 true', () => {
      expect(saveSubscription(USER, sub('https://push/a'))).toBe(true);
    });

    it('같은 엔드포인트를 다시 받으면 false (어드민 새로고침 = 이벤트 재수신)', () => {
      saveSubscription(USER, sub('https://push/a'));

      expect(saveSubscription(USER, sub('https://push/a'))).toBe(false);
      expect(saveSubscription(USER, sub('https://push/a'))).toBe(false);
    });

    it('키가 회전돼도 엔드포인트가 같으면 기존으로 본다', () => {
      saveSubscription(USER, sub('https://push/a', 'auth-1'));

      expect(saveSubscription(USER, sub('https://push/a', 'auth-2'))).toBe(false);
      expect(getSubscriptions(USER)).toHaveLength(1);
      expect(getSubscriptions(USER)[0]!.auth).toBe('auth-2'); // 갱신은 된다
    });

    it('유저가 알림을 껐다 켜면 새 엔드포인트라 다시 true', () => {
      saveSubscription(USER, sub('https://push/a'));

      expect(saveSubscription(USER, sub('https://push/b'))).toBe(true);
      expect(getSubscriptions(USER)).toHaveLength(2);
    });
  });

  describe('기기별 다중 구독', () => {
    it('한 사람이 PC와 폰을 따로 등록할 수 있다', () => {
      saveSubscription(USER, sub('https://push/pc'));
      saveSubscription(USER, sub('https://push/phone'));

      expect(getSubscriptions(USER).map(s => s.endpoint)).toEqual([
        'https://push/pc',
        'https://push/phone',
      ]);
    });

    it('다른 유저의 구독과 섞이지 않는다', () => {
      saveSubscription(USER, sub('https://push/a'));
      saveSubscription(OTHER, sub('https://push/b'));

      expect(getSubscriptions(USER)).toHaveLength(1);
      expect(getSubscriptions(OTHER)[0]!.endpoint).toBe('https://push/b');
    });
  });

  describe('죽은 구독 정리', () => {
    it('해당 엔드포인트만 지운다', () => {
      saveSubscription(USER, sub('https://push/dead'));
      saveSubscription(USER, sub('https://push/live'));

      removeSubscription(USER, 'https://push/dead');

      expect(getSubscriptions(USER).map(s => s.endpoint)).toEqual(['https://push/live']);
    });

    it('마지막 하나를 지우면 그 유저 항목이 사라진다', () => {
      saveSubscription(USER, sub('https://push/a'));
      removeSubscription(USER, 'https://push/a');

      expect(getSubscriptions(USER)).toEqual([]);
    });

    it('한 번 죽은 엔드포인트는 되살아나지 않는다', () => {
      saveSubscription(USER, sub('https://push/a'));
      removeSubscription(USER, 'https://push/a');

      // 릴레이가 옛 등록 이벤트를 다시 보내도 저장되지 않는다.
      // 이 가드가 없으면 매 부팅마다 신규 → 환영 알림 → 410 → 삭제가 무한히 돈다.
      expect(saveSubscription(USER, sub('https://push/a'))).toBe(false);
      expect(getSubscriptions(USER)).toEqual([]);
    });

    it('죽은 건 죽은 채로, 새 엔드포인트는 정상 등록된다', () => {
      saveSubscription(USER, sub('https://push/dead'));
      removeSubscription(USER, 'https://push/dead');

      expect(saveSubscription(USER, sub('https://push/fresh'))).toBe(true);
      expect(getSubscriptions(USER).map(s => s.endpoint)).toEqual(['https://push/fresh']);
    });
  });

  describe('등록된 적 없는 유저', () => {
    it('빈 배열을 돌려준다', () => {
      expect(getSubscriptions('nobody')).toEqual([]);
    });
  });
});
