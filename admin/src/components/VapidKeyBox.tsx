/**
 * VAPID 개인키 입력
 *
 * Web Push를 보내려면 이 키가 있어야 한다. 공개키는 코드에 박혀 있지만 개인키는
 * 공개 레포에 커밋할 수 없어서 어드민이 1회 붙여넣는다.
 *
 * 없으면 푸시가 **조용히** 안 나간다 — 거래는 정상 진행되고 로그에만 경고가
 * 남는다. 그래서 설정 화면에서 상태가 눈에 보여야 한다.
 */
import { useEffect, useState } from 'react';
import {
  getVapidPrivateKey,
  setVapidPrivateKey,
  restoreVapidPrivateKey,
  isValidVapidPrivateKey,
} from '../web-push/vapid-store';

export function VapidKeyBox() {
  const [stored, setStored] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 다른 어드민 기기에서 입력한 키가 릴레이 백업에 있으면 가져온다.
    void restoreVapidPrivateKey()
      .catch(() => {})
      .then(() => setStored(getVapidPrivateKey()));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await setVapidPrivateKey(input);
      setStored(getVapidPrivateKey());
      setInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.box}>
      <div style={styles.head}>
        <b style={styles.title}>Web Push 발송 키</b>
        <span style={stored ? styles.ok : styles.missing}>
          {stored ? '설정됨' : '없음 — 푸시 발송 안 됨'}
        </span>
      </div>

      <p style={styles.desc}>
        VAPID 개인키(base64url 43자). 릴레이에 암호화 백업되어 다른 어드민 기기에서도
        자동으로 불러옵니다. 이 키를 바꾸면 기존 구독이 전부 무효가 됩니다.
      </p>

      <div style={styles.row}>
        <input
          style={styles.input}
          type="password"
          placeholder={stored ? '교체하려면 새 키 입력' : 'VAPID private key (d)'}
          value={input}
          onChange={e => setInput(e.target.value)}
          autoComplete="off"
        />
        <button
          style={isValidVapidPrivateKey(input) && !saving ? styles.saveBtn : styles.saveBtnOff}
          onClick={handleSave}
          disabled={!isValidVapidPrivateKey(input) || saving}
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>

      {error && <p style={styles.error}>{error}</p>}
    </div>
  );
}

const styles = {
  box: {
    marginTop: 24,
    paddingTop: 20,
    borderTop: '1px solid #E5E7EB',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  title: { fontSize: 14 },
  ok: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#DCFCE7',
    color: '#166534',
  },
  missing: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#FEF3C7',
    color: '#92400E',
  },
  desc: {
    margin: '0 0 10px 0',
    fontSize: 12,
    lineHeight: 1.6,
    color: '#6B7280',
  },
  row: { display: 'flex', gap: 8 },
  input: {
    flex: 1,
    padding: '8px 10px',
    border: '1px solid #D1D5DB',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'inherit',
  },
  saveBtn: {
    padding: '8px 16px',
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  saveBtnOff: {
    padding: '8px 16px',
    background: '#E5E7EB',
    color: '#9CA3AF',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'not-allowed',
    fontFamily: 'inherit',
  },
  error: {
    margin: '8px 0 0 0',
    fontSize: 12,
    color: '#DC2626',
  },
};
