import { useState } from 'react';
import type { LnConfig } from '../nostr/ln-config';
import { publishLnConfig } from '../nostr/ln-config';
import type { LightningBackend } from '../lightning';

interface Props {
  onSave: (config: LnConfig) => void;
  onBack: () => void;
}

export function LnConfigPage({ onSave, onBack }: Props) {
  const [backend, setBackend] = useState<LightningBackend>('lnd');
  const [baseUrl, setBaseUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = baseUrl.trim() !== '' && credential.trim() !== '';

  async function handleSave() {
    if (!canSave) return;

    const config: LnConfig = {
      backend,
      baseUrl: baseUrl.trim(),
      credential: credential.trim(),
    };

    setSaving(true);
    setError(null);

    try {
      await publishLnConfig(config);
      onSave(config);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '알 수 없는 오류';
      setError(`릴레이 발행 실패: ${message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.card}>
      <h2 style={styles.title}>Lightning 노드 설정</h2>
      <p style={styles.desc}>
        설정은 NIP-44로 암호화되어 Nostr 릴레이에 저장됩니다.
      </p>

      <label style={styles.label}>
        백엔드
        <select
          style={styles.select}
          value={backend}
          onChange={(e) => setBackend(e.target.value as LightningBackend)}
        >
          <option value="lnd">LND</option>
          <option value="cln">Core Lightning (CLN)</option>
        </select>
      </label>

      <label style={styles.label}>
        REST API URL
        <input
          style={styles.input}
          type="text"
          placeholder="https://ln-rest.example.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>

      <label style={styles.label}>
        {backend === 'lnd' ? 'Macaroon (hex)' : 'Rune'}
        <textarea
          style={styles.textarea}
          placeholder={backend === 'lnd' ? 'admin macaroon hex...' : 'rune string...'}
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
        />
      </label>

      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.actions}>
        <button style={styles.backBtn} onClick={onBack} disabled={saving}>
          뒤로
        </button>
        <button
          style={canSave && !saving ? styles.saveBtn : styles.saveBtnDisabled}
          onClick={handleSave}
          disabled={!canSave || saving}
        >
          {saving ? '저장 중...' : '암호화 후 저장'}
        </button>
      </div>
    </div>
  );
}

const styles = {
  card: {
    maxWidth: 480,
    margin: '0 auto',
    padding: '32px 28px',
    background: '#fff',
    borderRadius: 12,
    boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
  },
  title: {
    fontSize: 20,
    fontWeight: 700 as const,
    color: '#333',
    margin: '0 0 4px',
  },
  desc: {
    fontSize: 13,
    color: '#888',
    margin: '0 0 24px',
  },
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600 as const,
    color: '#555',
    marginBottom: 16,
  },
  select: {
    display: 'block',
    width: '100%',
    marginTop: 6,
    padding: '8px 10px',
    fontSize: 14,
    border: '1px solid #D1D5DB',
    borderRadius: 6,
    background: '#fff',
  },
  input: {
    display: 'block',
    width: '100%',
    marginTop: 6,
    padding: '8px 10px',
    fontSize: 14,
    border: '1px solid #D1D5DB',
    borderRadius: 6,
    boxSizing: 'border-box' as const,
  },
  textarea: {
    display: 'block',
    width: '100%',
    marginTop: 6,
    padding: '8px 10px',
    fontSize: 13,
    fontFamily: 'monospace',
    border: '1px solid #D1D5DB',
    borderRadius: 6,
    minHeight: 72,
    resize: 'vertical' as const,
    boxSizing: 'border-box' as const,
  },
  error: {
    fontSize: 13,
    color: '#DC2626',
    margin: '0 0 12px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: 24,
  },
  backBtn: {
    padding: '8px 20px',
    fontSize: 14,
    color: '#666',
    background: '#F3F4F6',
    border: '1px solid #E5E7EB',
    borderRadius: 8,
    cursor: 'pointer' as const,
  },
  saveBtn: {
    padding: '8px 24px',
    fontSize: 14,
    fontWeight: 600 as const,
    color: '#fff',
    background: '#4F46E5',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer' as const,
  },
  saveBtnDisabled: {
    padding: '8px 24px',
    fontSize: 14,
    fontWeight: 600 as const,
    color: '#fff',
    background: '#9CA3AF',
    border: 'none',
    borderRadius: 8,
    cursor: 'not-allowed' as const,
  },
} as const;
