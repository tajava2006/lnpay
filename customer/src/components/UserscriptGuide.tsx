import { useState } from 'react';
import { KeyExport } from './KeyExport';

export function UserscriptGuide() {
  const [expanded, setExpanded] = useState(false);
  const [scriptContent, setScriptContent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleExpand() {
    setExpanded(prev => !prev);
    if (!scriptContent) {
      try {
        const res = await fetch('/sajwo-coupang-parser.user.js');
        if (res.ok) {
          setScriptContent(await res.text());
        } else {
          setScriptContent('// 유저스크립트 파일을 찾을 수 없습니다. pnpm build:userscript를 실행하세요.');
        }
      } catch {
        setScriptContent('// 유저스크립트 파일을 불러올 수 없습니다.');
      }
    }
  }

  async function handleCopy() {
    if (!scriptContent) return;
    await navigator.clipboard.writeText(scriptContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={styles.card}>
      <button onClick={handleExpand} style={styles.headerBtn}>
        <span style={styles.headerTitle}>쿠팡 자동 파싱 (유저스크립트)</span>
        <span style={styles.arrow}>{expanded ? '\u25B2' : '\u25BC'}</span>
      </button>

      {expanded && (
        <div style={styles.body}>
          <div style={styles.steps}>
            <p style={styles.step}><strong>1.</strong> Tampermonkey 확장 프로그램을 설치합니다.</p>
            <p style={styles.step}><strong>2.</strong> 아래 "유저스크립트 키"를 복사합니다.</p>
            <p style={styles.step}><strong>3.</strong> Tampermonkey에서 새 스크립트를 만들고 아래 코드를 붙여넣습니다.</p>
            <p style={styles.step}><strong>4.</strong> 쿠팡 주문 상세 페이지를 방문하면 자동으로 주문이 감지됩니다.</p>
          </div>

          <KeyExport />

          {scriptContent && (
            <div style={styles.codeSection}>
              <div style={styles.codeHeader}>
                <span style={styles.codeTitle}>유저스크립트</span>
                <button onClick={handleCopy} style={styles.copyBtn}>
                  {copied ? '복사됨' : '코드 복사'}
                </button>
              </div>
              <pre style={styles.codeBlock}>{scriptContent}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  card: {
    background: 'white',
    borderRadius: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    marginTop: 24,
    overflow: 'hidden',
  },
  headerBtn: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    padding: '16px 20px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 16,
    color: '#333',
    textAlign: 'left' as const,
  },
  headerTitle: {
    fontWeight: 600 as const,
  },
  arrow: {
    fontSize: 12,
    color: '#999',
  },
  body: {
    padding: '0 20px 20px',
  },
  steps: {
    marginBottom: 16,
  },
  step: {
    fontSize: 13,
    color: '#555',
    margin: '6px 0',
    lineHeight: 1.5,
  },
  codeSection: {
    marginTop: 16,
  },
  codeHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  codeTitle: {
    fontSize: 13,
    fontWeight: 600 as const,
    color: '#333',
  },
  copyBtn: {
    padding: '4px 12px',
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
  },
  codeBlock: {
    background: '#1E1E1E',
    color: '#D4D4D4',
    padding: 16,
    borderRadius: 8,
    fontSize: 11,
    lineHeight: 1.4,
    overflow: 'auto',
    maxHeight: 400,
    whiteSpace: 'pre' as const,
    margin: 0,
  },
};
