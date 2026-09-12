import { useState } from 'react';
import { addOrder } from '../order-store';
import { newOrderId } from '../order-id';
import type { CustomerOrder } from '../types';

const DEFAULT_EXPIRY_HOURS = 24;

export function OrderForm() {
  const [price, setPrice] = useState('');
  const [memo, setMemo] = useState('');
  const [expiryHours, setExpiryHours] = useState(String(DEFAULT_EXPIRY_HOURS));

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const priceNum = Number(price);
    if (!priceNum || priceNum <= 0) {
      alert('금액을 입력해주세요.');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const hours = Number(expiryHours) || DEFAULT_EXPIRY_HOURS;
    const expiration = now + hours * 3600;

    const orderId = newOrderId();

    const order: CustomerOrder = {
      orderId,
      price: priceNum,
      memo: memo.trim() || '직접 입력',
      createdAt: now,
      expiration,
    };

    addOrder(order);
    setPrice('');
    setMemo('');
    setExpiryHours(String(DEFAULT_EXPIRY_HOURS));
  }

  return (
    <div style={styles.card}>
      <h2 style={styles.title}>의뢰 등록</h2>
      <form onSubmit={handleSubmit} style={styles.form}>
        <label style={styles.label}>
          <span style={styles.labelText}>금액 (원) *</span>
          <input
            type="number"
            value={price}
            onChange={e => setPrice(e.target.value)}
            placeholder="예: 50000"
            required
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          <span style={styles.labelText}>메모</span>
          <input
            type="text"
            value={memo}
            onChange={e => setMemo(e.target.value)}
            placeholder="예: 맥북 프로 결제"
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          <span style={styles.labelText}>유효기간 (시간)</span>
          <input
            type="number"
            value={expiryHours}
            onChange={e => setExpiryHours(e.target.value)}
            min="1"
            max="72"
            style={styles.input}
          />
        </label>
        <button type="submit" style={styles.submitBtn}>의뢰 등록</button>
      </form>
    </div>
  );
}

const styles = {
  card: {
    background: 'white',
    borderRadius: 12,
    padding: 20,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    marginBottom: 24,
  },
  title: {
    fontSize: 18,
    color: '#333',
    margin: '0 0 16px 0',
  },
  form: {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-end',
    flexWrap: 'wrap' as const,
  },
  label: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    flex: '1 1 140px',
  },
  labelText: {
    fontSize: 13,
    color: '#666',
    fontWeight: 500 as const,
  },
  input: {
    padding: '8px 12px',
    border: '1px solid #ddd',
    borderRadius: 6,
    fontSize: 14,
    outline: 'none',
  },
  submitBtn: {
    padding: '8px 20px',
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500 as const,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    alignSelf: 'flex-end' as const,
  },
};
