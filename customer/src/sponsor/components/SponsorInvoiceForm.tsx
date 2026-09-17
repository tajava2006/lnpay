/**
 * 지급받을 인보이스 제출
 *
 * 에스크로가 잡힌 뒤(`escrowed`) 후원자가 할 일이다. 이걸 내야 고객이 계좌
 * 정보를 보낸다 — 즉 **이 화면을 통과하지 않으면 원화를 보낼 수 없다.**
 * 순서가 불편해 보이지만 그게 목적이다: 받을 준비가 확인된 뒤에만 되돌릴 수
 * 없는 이체를 하게 만든다. 근거 = docs/DESIGN-LATE-INVOICE.md
 *
 * 금액은 **정확히** 일치해야 한다. 어드민이 시세로 정해 오더에 실어 보낸 값이고,
 * 1 sat만 달라도 거절된다. 그래서 여기서 미리 대조해 보여준다 — 릴레이를 돌고
 * 와서야 거절 사유를 아는 것보다 낫다.
 */
import { useState } from 'react';
import type { Order } from '@sajwo-tracker/shared';
import { publishSponsorInvoice } from '../nostr/claim';
import { decodeBolt11 } from '../bolt11';

/** 어드민이 요구하는 최소 잔여 수명과 같은 값. 미리 걸러 왕복을 아낀다. */
const MIN_LIFETIME_SEC = 6 * 60 * 60;

interface Props {
  order: Order;
  /** 어드민이 보낸 거절 사유 (있으면 표시) */
  notice: string | null;
  onSubmitted: () => void;
}

export function SponsorInvoiceForm({ order, notice, onSubmitted }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payoutSat = order.payoutSat ?? 0;
  const decoded = text.trim() ? decodeBolt11(text.trim()) : null;

  // 제출 전 자가 검증. 어드민의 판정과 같은 기준이라 여기서 통과하면 대개 통과한다.
  const problem = (() => {
    if (!text.trim()) return null;
    if (!decoded?.valid) return '인보이스를 읽을 수 없습니다.';
    // 금액 없는(zero-amount) 인보이스는 받지 않는다 — 얼마를 보낼지가 애매해진다.
    if (decoded.amountMsat === null) {
      return `금액이 없는 인보이스입니다. ${payoutSat.toLocaleString()} sats를 지정해 만들어 주세요.`;
    }
    const sat = Math.round(decoded.amountMsat / 1000);
    if (sat !== payoutSat) {
      return `금액이 다릅니다. ${payoutSat.toLocaleString()} sats로 정확히 만들어 주세요 (지금 ${sat.toLocaleString()} sats).`;
    }
    const remaining = decoded.expiresAt - Math.floor(Date.now() / 1000);
    if (remaining < MIN_LIFETIME_SEC) {
      return '유효시간이 너무 짧습니다. 최소 6시간 이상으로 만들어 주세요 — 원화 송금과 입금 확인에 시간이 걸립니다.';
    }
    return null;
  })();

  const canSubmit = !!text.trim() && !problem && !sending && payoutSat > 0;

  async function handleSubmit() {
    setSending(true);
    setError(null);
    try {
      const ok = await publishSponsorInvoice(order, text.trim());
      if (!ok) {
        setError('제출에 실패했습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
      onSubmitted();
    } catch {
      setError('제출 중 오류가 발생했습니다.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={styles.box}>
      <p style={styles.title}>BTC 받을 인보이스를 등록하세요</p>
      <p style={styles.lead}>
        등록해야 고객이 계좌 정보를 보냅니다. 그 전에는 원화를 보내지 마세요.
      </p>

      <div style={styles.amountRow}>
        <span style={styles.amountLabel}>정확히 이 금액으로</span>
        <b style={styles.amount}>{payoutSat.toLocaleString()} sats</b>
      </div>

      <textarea
        style={styles.input}
        placeholder="lnbc..."
        value={text}
        onChange={e => setText(e.target.value)}
        rows={3}
        spellCheck={false}
      />

      {problem && <p style={styles.problem}>{problem}</p>}
      {notice && !problem && <p style={styles.problem}>{notice}</p>}
      {error && <p style={styles.problem}>{error}</p>}

      <button
        style={canSubmit ? styles.btn : styles.btnOff}
        onClick={handleSubmit}
        disabled={!canSubmit}
      >
        {sending ? '등록 중…' : '인보이스 등록'}
      </button>
    </div>
  );
}

const styles = {
  box: {
    marginTop: 10,
    padding: 12,
    background: '#F5F3FF',
    border: '1px solid #DDD6FE',
    borderRadius: 8,
  },
  title: { margin: '0 0 4px 0', fontSize: 14, fontWeight: 600, color: '#5B21B6' },
  lead: { margin: '0 0 10px 0', fontSize: 12, lineHeight: 1.6, color: '#6D28D9' },
  amountRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 8,
  },
  amountLabel: { fontSize: 12, color: '#6B7280' },
  amount: { fontSize: 15, color: '#111827', fontFamily: 'monospace' },
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: 8,
    border: '1px solid #D1D5DB',
    borderRadius: 6,
    fontSize: 12,
    fontFamily: 'monospace',
    resize: 'vertical' as const,
  },
  problem: {
    margin: '8px 0 0 0',
    fontSize: 12,
    lineHeight: 1.6,
    color: '#B91C1C',
  },
  btn: {
    marginTop: 10,
    padding: '8px 16px',
    background: '#7C3AED',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnOff: {
    marginTop: 10,
    padding: '8px 16px',
    background: '#E5E7EB',
    color: '#9CA3AF',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'not-allowed',
    fontFamily: 'inherit',
  },
};
