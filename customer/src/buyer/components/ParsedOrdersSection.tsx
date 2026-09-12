import { useState, useSyncExternalStore } from 'react';
import { subscribeParsed, getParsedSnapshot, removeParsedOrder } from '../parsed-store';
import { addOrder } from '../order-store';
import { publishOrderRequest } from '../nostr/publish';
import { markPublished } from '../order-store';
import type { CustomerOrder } from '../types';
import { newOrderId } from '../order-id';
import type { ParsedOrderPayload } from '../types';

export function ParsedOrdersSection() {
  const parsed = useSyncExternalStore(subscribeParsed, getParsedSnapshot);
  const entries = Object.entries(parsed);

  if (entries.length === 0) return null;

  return (
    <div style={styles.card}>
      <h2 style={styles.title}>감지된 주문</h2>
      <p style={styles.desc}>유저스크립트가 쿠팡에서 감지한 무통장입금 주문입니다.</p>
      <div style={styles.list}>
        {entries.map(([eventId, payload]) => (
          <ParsedOrderCard key={eventId} eventId={eventId} payload={payload} />
        ))}
      </div>
    </div>
  );
}

function ParsedOrderCard({ eventId, payload }: { eventId: string; payload: ParsedOrderPayload }) {
  const [requesting, setRequesting] = useState(false);

  const expirationDate = new Date(payload.expirationDate);
  const expirationStr = `${expirationDate.getFullYear()}.${String(expirationDate.getMonth() + 1).padStart(2, '0')}.${String(expirationDate.getDate()).padStart(2, '0')} ${String(expirationDate.getHours()).padStart(2, '0')}:${String(expirationDate.getMinutes()).padStart(2, '0')}`;

  async function handleRequest() {
    setRequesting(true);
    try {
      const now = Math.floor(Date.now() / 1000);
      const order: CustomerOrder = {
        // 수동 주문과 같은 랜덤 id. 쿠팡 번호를 쓰면 공개 태그로 새어나간다(감사 A-3).
        orderId: newOrderId(),
        coupangOrderId: payload.coupangOrderId,
        price: payload.price,
        memo: payload.productName,
        createdAt: now,
        expiration: Math.floor(payload.expirationDate / 1000),
        source: 'parsed',
        fixedAccountInfo: {
          bankName: payload.bankName,
          accountNumber: payload.accountNumber,
          holderName: payload.depositor,
        },
      };

      addOrder(order);

      const result = await publishOrderRequest(order);
      if (result.success && result.raw) {
        markPublished(order.orderId, result.raw);
        removeParsedOrder(eventId);
      } else {
        alert('사줘 요청 발행에 실패했습니다.');
      }
    } catch {
      alert('사줘 요청 발행 중 오류가 발생했습니다.');
    } finally {
      setRequesting(false);
    }
  }

  function handleDismiss() {
    removeParsedOrder(eventId);
  }

  return (
    <div style={styles.orderCard}>
      <div style={styles.orderHeader}>
        <span style={styles.badge}>쿠팡 자동감지</span>
        <span style={styles.orderId}>#{payload.coupangOrderId}</span>
      </div>
      <div style={styles.orderBody}>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>상품</span>
          <span style={styles.fieldValue}>{payload.productName}</span>
        </div>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>금액</span>
          <span style={styles.fieldValue}>{payload.price.toLocaleString()}원</span>
        </div>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>입금 계좌</span>
          <span style={styles.fieldValue}>
            {payload.bankName} {payload.accountNumber} ({payload.depositor})
          </span>
        </div>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>입금 기한</span>
          <span style={styles.fieldValue}>{expirationStr}</span>
        </div>
      </div>
      <div style={styles.orderActions}>
        <button
          onClick={handleRequest}
          disabled={requesting}
          style={styles.requestBtn}
        >
          {requesting ? '요청 중...' : '사줘 요청'}
        </button>
        <button
          onClick={handleDismiss}
          disabled={requesting}
          style={styles.dismissBtn}
        >
          무시
        </button>
      </div>
    </div>
  );
}

const styles = {
  card: {
    background: '#FFFBEB',
    borderRadius: 12,
    padding: 20,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    marginBottom: 24,
    border: '1px solid #FDE68A',
  },
  title: {
    fontSize: 18,
    color: '#92400E',
    margin: '0 0 4px 0',
  },
  desc: {
    fontSize: 13,
    color: '#A16207',
    margin: '0 0 16px 0',
  },
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  orderCard: {
    background: 'white',
    borderRadius: 8,
    padding: 16,
    border: '1px solid #E5E7EB',
  },
  orderHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  badge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600 as const,
    background: '#FEF3C7',
    color: '#D97706',
  },
  orderId: {
    fontSize: 13,
    color: '#6B7280',
    fontFamily: 'monospace',
  },
  orderBody: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    marginBottom: 12,
  },
  field: {
    display: 'flex',
    gap: 8,
    fontSize: 13,
  },
  fieldLabel: {
    color: '#6B7280',
    minWidth: 70,
    flexShrink: 0,
  },
  fieldValue: {
    color: '#111827',
    fontWeight: 500 as const,
  },
  orderActions: {
    display: 'flex',
    gap: 8,
  },
  requestBtn: {
    padding: '8px 20px',
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500 as const,
    cursor: 'pointer',
  },
  dismissBtn: {
    padding: '8px 16px',
    background: 'transparent',
    color: '#6B7280',
    border: '1px solid #D1D5DB',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
  },
};
