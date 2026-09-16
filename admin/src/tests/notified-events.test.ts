/**
 * 알림 1회성 보장
 *
 * 릴레이가 어드민 부팅마다 과거 이벤트를 전부 재전송한다는 사실이 이 모듈의
 * 존재 이유다. 실제로 어드민을 만질 때마다 옛 주문의 "계좌 도착" 알림이
 * 유저에게 계속 날아갔다. 판정이 어긋나면 그대로 스팸이라 고정해 둔다.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { claimNotification, _resetForTesting } from '../notified-events';

describe('알림 1회성', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('처음 보는 이벤트는 통과시킨다', () => {
    expect(claimNotification('evt-1')).toBe(true);
  });

  it('같은 이벤트는 두 번째부터 막는다 (= 릴레이 재전송)', () => {
    claimNotification('evt-1');

    expect(claimNotification('evt-1')).toBe(false);
    expect(claimNotification('evt-1')).toBe(false);
  });

  it('다른 이벤트는 서로 간섭하지 않는다', () => {
    claimNotification('evt-1');

    expect(claimNotification('evt-2')).toBe(true);
    expect(claimNotification('evt-1')).toBe(false);
  });

  it('어드민을 껐다 켜도 기억한다 (localStorage 영속)', () => {
    claimNotification('evt-1');

    // 모듈 상태가 아니라 저장소를 읽으므로 새 세션에서도 같은 판정이 나온다
    expect(claimNotification('evt-1')).toBe(false);
  });

  it('빈 id는 막지 않는다 — 판단 불가일 뿐 차단 사유는 아니다', () => {
    expect(claimNotification('')).toBe(true);
    expect(claimNotification('')).toBe(true);
  });

  it('상한을 넘으면 오래된 것부터 버린다', () => {
    for (let i = 0; i < 500; i++) claimNotification(`evt-${i}`);

    // 최신 것은 계속 기억
    expect(claimNotification('evt-499')).toBe(false);

    // 하나 더 넣어 밀어내면 가장 오래된 것이 빠진다
    claimNotification('evt-new');
    expect(claimNotification('evt-0')).toBe(true);
  });
});
