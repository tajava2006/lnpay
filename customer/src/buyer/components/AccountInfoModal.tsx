import { useEffect, useState } from 'react';
import type { AccountInfo } from '@sajwo-tracker/shared';

interface Props {
  orderId: string;
  onClose: () => void;
  onSubmit: (info: AccountInfo) => void;
  submitting: boolean;
}

const BANKS = [
  '국민은행', '신한은행', '우리은행', '하나은행', 'NH농협은행',
  'IBK기업은행', 'SC제일은행', '한국시티은행', 'KDB산업은행',
  '카카오뱅크', '토스뱅크', '케이뱅크',
  '우체국', '새마을금고', '신협', '수협은행',
  'DGB대구은행', 'BNK부산은행', 'BNK경남은행',
  '광주은행', '전북은행', '제주은행',
];

export function AccountInfoModal({ orderId, onClose, onSubmit, submitting }: Props) {
  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [holderName, setHolderName] = useState('');

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const isValid = bankName.length > 0 && accountNumber.trim().length > 0 && holderName.trim().length > 0;

  function handleSubmit() {
    if (!isValid || submitting) return;
    onSubmit({
      bankName,
      accountNumber: accountNumber.trim(),
      holderName: holderName.trim(),
    });
  }

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div style={styles.modal}>
        <div style={styles.header}>
          <h3 style={styles.headerTitle}>계좌 정보 전달</h3>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>
        <div style={styles.body}>
          <p style={styles.desc}>
            의뢰 <strong>#{orderId}</strong>의 후원자에게 전달할 계좌 정보를 입력하세요.
            이 정보는 암호화되어 후원자만 열람할 수 있습니다.
          </p>

          <label style={styles.label}>은행</label>
          <select
            style={styles.select}
            value={bankName}
            onChange={e => setBankName(e.target.value)}
          >
            <option value="">선택하세요</option>
            {BANKS.map(b => <option key={b} value={b}>{b}</option>)}
          </select>

          <label style={styles.label}>계좌번호</label>
          <input
            style={styles.input}
            type="text"
            placeholder="'-' 포함 가능"
            value={accountNumber}
            onChange={e => setAccountNumber(e.target.value)}
          />

          <label style={styles.label}>예금주</label>
          <input
            style={styles.input}
            type="text"
            placeholder="예금주명"
            value={holderName}
            onChange={e => setHolderName(e.target.value)}
          />

          <div style={styles.btnRow}>
            <button
              style={{
                ...styles.submitBtn,
                opacity: isValid && !submitting ? 1 : 0.5,
                cursor: isValid && !submitting ? 'pointer' : 'not-allowed',
              }}
              onClick={handleSubmit}
              disabled={!isValid || submitting}
            >
              {submitting ? '전달 중...' : '계좌 전달'}
            </button>
            <button
              style={styles.cancelBtn}
              onClick={onClose}
              disabled={submitting}
            >
              취소
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

const styles = {
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    zIndex: 999,
  },
  modal: {
    position: 'fixed' as const,
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    background: 'white',
    borderRadius: 16,
    padding: 32,
    maxWidth: 400,
    width: '90%',
    zIndex: 1000,
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  headerTitle: {
    margin: 0,
    fontSize: 20,
    color: '#333',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 24,
    cursor: 'pointer',
    color: '#999',
    padding: '0 4px',
  },
  body: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  desc: {
    fontSize: 13,
    color: '#666',
    lineHeight: 1.5,
    margin: '0 0 8px',
  },
  label: {
    fontSize: 13,
    fontWeight: 600 as const,
    color: '#333',
  },
  select: {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid #ddd',
    fontSize: 14,
    boxSizing: 'border-box' as const,
  },
  input: {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid #ddd',
    fontSize: 14,
    boxSizing: 'border-box' as const,
  },
  btnRow: {
    display: 'flex',
    gap: 8,
    marginTop: 8,
  },
  submitBtn: {
    flex: 1,
    background: '#4F46E5',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '10px 16px',
    fontSize: 14,
    fontWeight: 600 as const,
    cursor: 'pointer',
  },
  cancelBtn: {
    background: 'transparent',
    color: '#666',
    border: '1px solid #ddd',
    borderRadius: 6,
    padding: '10px 16px',
    fontSize: 14,
    cursor: 'pointer',
  },
};
