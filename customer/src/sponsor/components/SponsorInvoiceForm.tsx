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
import { useState, useCallback, lazy, Suspense } from 'react';
import type { Order } from '@sajwo-tracker/shared';
import { publishSponsorInvoice } from '../nostr/claim';
import { decodeBolt11 } from '../bolt11';

// 폰 지갑에서 인보이스를 옮기는 현실적인 방법은 QR이다. 클레임 화면에 있던 걸
// 인보이스를 실제로 입력하는 여기로 옮겼다.
const QrScanner = lazy(() => import('./QrScanner').then(m => ({ default: m.QrScanner })));

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
  // 발행 성공과 어드민 수락은 다른 사건이다. 그 사이를 화면이 말해주지 않으면
  // 유저는 "안 됐나?" 하고 다시 누른다(실제로 그랬다).
  const [submitted, setSubmitted] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleScan = useCallback((data: string) => {
    setScanning(false);
    setText(data.trim());
  }, []);

  // payout이 없으면 **금액을 모르는 것**이다. 0으로 표시하면 화면이 거짓말을
  // 하게 되고, 유저는 0 sats짜리를 만들려다 시간을 버린다(실제로 그랬다).
  const payoutSat = order.payoutSat ?? null;
  const decoded = text.trim() ? decodeBolt11(text.trim()) : null;

  // 제출 전 자가 검증. 어드민의 판정과 같은 기준이라 여기서 통과하면 대개 통과한다.
  const problem = (() => {
    if (payoutSat === null) return null;
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

  const canSubmit = !!text.trim() && !problem && !sending && payoutSat !== null;
  // 거절 통보가 오면 "보냈음" 상태를 풀어 다시 낼 수 있게 한다.
  const waiting = submitted && !notice;

  async function handleSubmit() {
    setSending(true);
    setError(null);
    setSubmitted(false);
    try {
      const ok = await publishSponsorInvoice(order, text.trim());
      if (!ok) {
        setError('제출에 실패했습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
      setSubmitted(true);
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

      {payoutSat === null ? (
        <div style={styles.missingAmount}>
          <b>받을 금액을 아직 받아오지 못했습니다.</b> 잠시 후 새로고침해 보시고,
          계속 이 상태면 이 의뢰는 진행할 수 없습니다 — 어드민에 문의해 주세요.
        </div>
      ) : (
        <div style={styles.amountRow}>
          <span style={styles.amountLabel}>정확히 이 금액으로</span>
          <b style={styles.amount}>{payoutSat.toLocaleString()} sats</b>
        </div>
      )}

      <div style={styles.inputRow}>
        <textarea
          style={styles.input}
          placeholder="lnbc..."
          value={text}
          onChange={e => setText(e.target.value)}
          rows={3}
          spellCheck={false}
        />
        <button
          style={styles.qrBtn}
          onClick={() => setScanning(true)}
          title="QR 코드 스캔"
          type="button"
        >
          📷
        </button>
      </div>

      {scanning && (
        <Suspense fallback={null}>
          <QrScanner onScan={handleScan} onClose={() => setScanning(false)} />
        </Suspense>
      )}

      {waiting && (
        <p style={styles.waiting}>
          등록했습니다. 어드민이 확인하면 고객이 계좌 정보를 보냅니다 —
          잠시 기다려 주세요. 다시 보내지 않으셔도 됩니다.
        </p>
      )}

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
  missingAmount: {
    padding: 10,
    marginBottom: 8,
    background: '#FEF2F2',
    border: '1px solid #FECACA',
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 1.6,
    color: '#991B1B',
  },
  amount: { fontSize: 15, color: '#111827', fontFamily: 'monospace' },
  inputRow: { display: 'flex', gap: 6, alignItems: 'stretch' },
  qrBtn: {
    padding: '0 12px',
    background: 'white',
    border: '1px solid #D1D5DB',
    borderRadius: 6,
    fontSize: 18,
    cursor: 'pointer',
  },
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
  waiting: {
    margin: '8px 0 0 0',
    fontSize: 12,
    lineHeight: 1.6,
    color: '#166534',
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
