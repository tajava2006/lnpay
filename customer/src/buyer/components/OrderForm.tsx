import { useState } from 'react';
import { addOrder } from '../order-store';
import { newOrderId } from '../order-id';
import type { CustomerOrder } from '../types';

const DEFAULT_EXPIRY_HOURS = 24;

/**
 * 의뢰 유효기간 선택지.
 *
 * 길게 잡아도 안전하다 — 홀드 인보이스 수명은 여기서 분리돼 있어서(escrow-window.ts)
 * 후원자가 붙은 뒤 하루 안에 결제하면 된다. 예전엔 이 값이 곧 CLTV라 길게 잡으면
 * 채널 상한을 넘어 터졌다.
 *
 * 쿠팡 가상계좌는 하루면 죽으므로 **주문은 후원자가 붙은 뒤에** 넣는 게 맞다.
 * 그래서 긴 유효기간이 의미가 있다.
 */
const EXPIRY_OPTIONS = [
  { hours: 24, label: '1일' },
  { hours: 72, label: '3일' },
  { hours: 24 * 7, label: '1주' },
  { hours: 24 * 30, label: '1개월' },
  { hours: 24 * 90, label: '3개월' },
] as const;

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
          <span style={styles.labelText}>유효기간</span>
          <select
            value={expiryHours}
            onChange={e => setExpiryHours(e.target.value)}
            style={styles.input}
          >
            {EXPIRY_OPTIONS.map(o => (
              <option key={o.hours} value={o.hours}>{o.label}</option>
            ))}
          </select>
        </label>
        <p style={styles.expiryHint}>
          급하지 않으면 길게 잡아두세요. 후원자가 붙을 때까지 기다렸다가,
          그때 쿠팡 주문을 넣어 이 의뢰에 연결하면 됩니다.
        </p>
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
  expiryHint: {
    margin: '-4px 0 8px 0',
    fontSize: 12,
    lineHeight: 1.6,
    color: '#6B7280',
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
