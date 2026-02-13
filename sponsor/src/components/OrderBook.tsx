import { useEffect, useRef, useState, useCallback } from 'react';
import type { Event } from 'nostr-tools/core';
import { getRelays } from '@sajwo-tracker/shared';
import { storage } from '../nostr/storage';
import { subscribeSajwoRequests } from '../nostr/subscribe';
import { getAllOrders, upsertOrder, deleteOrder } from '../storage';
import { parseEvent, type SajwoRequest } from '../types';
import { OrderCard } from './OrderCard';

export function OrderBook() {
  // localStorage에서 즉시 로드하여 초기값으로 사용
  const [orders, setOrders] = useState<Record<string, SajwoRequest>>(() => getAllOrders());
  const [syncing, setSyncing] = useState(true);
  const cleanupRef = useRef<(() => void) | null>(null);

  const handleActive = useCallback((event: Event) => {
    const parsed = parseEvent(event);
    if (!parsed) return;

    if (upsertOrder(parsed)) {
      setOrders((prev) => ({ ...prev, [parsed.orderId]: parsed }));
    }
  }, []);

  const handleSold = useCallback((event: Event) => {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1];
    if (!dTag) return;

    if (deleteOrder(dTag)) {
      setOrders((prev) => {
        const next = { ...prev };
        delete next[dTag];
        return next;
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const relays = await getRelays(storage);
        if (cancelled) return;

        const cleanup = subscribeSajwoRequests(relays, {
          onActive: handleActive,
          onSold: handleSold,
          onEose: () => {
            if (!cancelled) setSyncing(false);
          },
        });

        cleanupRef.current = cleanup;
      } catch (err) {
        console.error('[OrderBook] Subscription failed:', err);
        if (!cancelled) setSyncing(false);
      }
    }

    init();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
    };
  }, [handleActive, handleSold]);

  const now = Math.floor(Date.now() / 1000);

  // 만료되지 않은 요청만 필터링, created_at 내림차순
  const activeRequests = Object.values(orders)
    .filter((r) => !r.expiresAt || r.expiresAt > now)
    .sort((a, b) => b.createdAt - a.createdAt);

  if (activeRequests.length === 0 && syncing) {
    return <div style={styles.message}>릴레이에서 사줘 요청을 불러오는 중...</div>;
  }

  if (activeRequests.length === 0) {
    return <div style={styles.message}>현재 활성 사줘 요청이 없습니다</div>;
  }

  return (
    <div>
      {syncing && <div style={styles.syncBadge}>동기화 중...</div>}
      <div style={styles.list}>
        {activeRequests.map((request) => (
          <OrderCard key={request.orderId} request={request} />
        ))}
      </div>
    </div>
  );
}

const styles = {
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  message: {
    textAlign: 'center' as const,
    padding: 48,
    color: '#666',
    fontSize: 14,
  },
  syncBadge: {
    textAlign: 'center' as const,
    padding: '6px 0',
    marginBottom: 12,
    fontSize: 12,
    color: '#999',
  },
};
