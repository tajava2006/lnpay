import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  subscribeChatStore, getChatSnapshot,
  addMessage, loadFromIdb, clearMessages,
} from '../chat-store';
import { subscribeChatMessages } from '../nostr/chat-subscribe';
import { publishDisputeMessage } from '../nostr/publish';
import { ChatWindow } from './ChatWindow';
import { getDisplayMeta } from '../order-states';
import { getUserPubkey } from '@sajwo-tracker/shared';
import type { DisputeMessagePayload } from '@sajwo-tracker/shared';
import type { CustomerOrder } from '../types';
import { storage } from '../nostr/storage';

interface Props {
  order: CustomerOrder;
  onClose: () => void;
}

export function OrderDetail({ order, onClose }: Props) {
  const [myPubkey, setMyPubkey] = useState<string | null>(null);

  // Escape key to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Load own pubkey
  useEffect(() => {
    void getUserPubkey(storage).then(setMyPubkey);
  }, []);

  // Chat subscription lifecycle
  useEffect(() => {
    let cleanup: (() => void) | null = null;

    void loadFromIdb(order.orderId);
    void subscribeChatMessages(order.orderId, msg => addMessage(msg))
      .then(unsub => { cleanup = unsub; });

    return () => {
      cleanup?.();
      clearMessages(order.orderId);
    };
  }, [order.orderId]);

  const chatSnapshot = useSyncExternalStore(subscribeChatStore, getChatSnapshot);
  const messages = chatSnapshot[order.orderId] ?? [];

  // Send handler (Customer → Admin)
  const handleSend = useCallback(async (text: string) => {
    const payload: DisputeMessagePayload = { type: 'text', content: text };
    await publishDisputeMessage(order, payload);
  }, [order]);

  const meta = getDisplayMeta(order);
  const date = new Date(order.createdAt * 1000).toLocaleString('ko-KR', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div style={styles.modal}>
        <div style={styles.header}>
          <h3 style={styles.headerTitle}>주문 #{order.orderId} 상세</h3>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>

        {/* Order Summary */}
        <div style={styles.summary}>
          <div style={styles.summaryRow}>
            <span style={styles.price}>{order.price.toLocaleString()}원</span>
            <span style={{
              display: 'inline-block',
              padding: '4px 12px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              background: meta.bgColor,
              color: meta.textColor,
            }}>
              {meta.label}
            </span>
          </div>
          {order.memo && (
            <div style={styles.memo}>{order.memo}</div>
          )}
          <div style={styles.meta}>
            <span>{date}</span>
            {order.source === 'parsed' && (
              <span style={styles.parsedBadge}>자동 파싱</span>
            )}
          </div>
        </div>

        {/* Chat Window (Customer ↔ Admin) */}
        {myPubkey && (
          <ChatWindow
            label="Admin 채팅"
            messages={messages}
            myPubkey={myPubkey}
            onSend={handleSend}
          />
        )}
      </div>
    </>
  );
}

const styles = {
  backdrop: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    background: 'rgba(0,0,0,0.4)',
    zIndex: 1000,
  },
  modal: {
    position: 'fixed' as const,
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '90%',
    maxWidth: 520,
    maxHeight: '85vh',
    overflowY: 'auto' as const,
    background: '#fff',
    borderRadius: 12,
    boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
    zIndex: 1001,
    padding: 24,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 600 as const,
    color: '#333',
    margin: 0,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 24,
    color: '#999',
    cursor: 'pointer' as const,
    padding: '0 4px',
    lineHeight: 1,
  },
  summary: {
    background: '#F9FAFB',
    border: '1px solid #E5E7EB',
    borderRadius: 8,
    padding: '12px 16px',
    marginBottom: 16,
  },
  summaryRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  price: {
    fontSize: 18,
    fontWeight: 700 as const,
    color: '#4F46E5',
  },
  memo: {
    fontSize: 13,
    color: '#666',
    marginBottom: 6,
  },
  meta: {
    display: 'flex',
    gap: 12,
    fontSize: 12,
    color: '#999',
    alignItems: 'center',
  },
  parsedBadge: {
    fontSize: 11,
    color: '#2563EB',
    background: '#DBEAFE',
    padding: '2px 8px',
    borderRadius: 4,
  },
} as const;
