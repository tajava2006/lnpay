/**
 * 옛 어드민 저장소 청소 — 전부 지우고 지금 로그인 세션만 남긴다
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLegacyStorage, legacyKeys } from './legacy-storage';

describe('legacyKeys', () => {
  it('옛 장부·비밀·설정은 전부 지운다', () => {
    const keys = [
      'admin:orders', 'admin:requests', 'admin:escrow', 'admin:pending-deposits', 'admin:customerDepositPercent',
      'admin:onchain-orders', 'admin:onchain-keys', 'admin:onchain-key:abc', 'admin:onchain-meta', 'admin:device-id',
      'auto-approve-enabled', 'notified-events', 'push-subscriptions', 'push-subscriptions-dead', 'vapid-private-key',
    ];
    expect(legacyKeys(keys)).toEqual(keys);
  });

  it('지금 세션·새 캐시·다른 앱 키는 남긴다', () => {
    expect(legacyKeys(['admin:nip46', 'admin2:ln-orders', 'admin2:legacy-cleared', 'nostr:identity-published'])).toEqual([]);
  });
});

describe('clearLegacyStorage', () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('한 번만 돈다 — IndexedDB `admin-history`도 지운다', () => {
    const deleteDatabase = vi.fn();
    vi.stubGlobal('indexedDB', { deleteDatabase });
    localStorage.setItem('admin:orders', '{}');
    localStorage.setItem('admin:nip46', 'session');
    clearLegacyStorage();
    expect(localStorage.getItem('admin:orders')).toBeNull();
    expect(localStorage.getItem('admin:nip46')).toBe('session');
    expect(deleteDatabase).toHaveBeenCalledWith('admin-history');

    localStorage.setItem('admin:orders', '{}');
    clearLegacyStorage();
    expect(localStorage.getItem('admin:orders')).toBe('{}');
    expect(deleteDatabase).toHaveBeenCalledTimes(1);
  });
});
