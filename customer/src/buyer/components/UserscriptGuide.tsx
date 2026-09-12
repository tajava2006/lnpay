import { useState } from 'react';
import { nsecEncode } from 'nostr-tools/nip19';
import { getSecretKey, storage } from '@sajwo-tracker/shared';

const NSEC_PLACEHOLDER = '%%NSEC_PLACEHOLDER%%';

/** 공식 Chrome 웹스토어 배포처 */
const TAMPERMONKEY_URL = 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo?hl=ko';

/** 배너에서 @version을 뽑는다. 어느 빌드를 복사하는지 눈으로 확인할 수 있게. */
function extractVersion(raw: string): string | null {
  return /^\/\/\s*@version\s+(\S+)/m.exec(raw)?.[1] ?? null;
}

export function UserscriptGuide() {
  const [expanded, setExpanded] = useState(false);
  const [scriptContent, setScriptContent] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleExpand() {
    setExpanded(prev => !prev);
    if (!scriptContent) {
      try {
        const [res, sk] = await Promise.all([
          // no-store 필수. 이 응답엔 Cache-Control이 없어 브라우저가 휴리스틱
          // 캐싱(= Last-Modified 기준 경과시간의 10%)을 적용하는데, 그러면
          // 새로 배포해도 몇 시간 동안 옛 스크립트를 복사하게 된다.
          // 가이드의 존재 이유가 "지금 빌드를 건네주는 것"이라 캐시를 타면 안 된다.
          fetch('/sajwo-coupang-parser.user.js', { cache: 'no-store' }),
          getSecretKey(storage),
        ]);
        if (res.ok) {
          const raw = await res.text();
          const nsec = nsecEncode(sk);
          setVersion(extractVersion(raw));
          setScriptContent(raw.split(NSEC_PLACEHOLDER).join(nsec));
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
            <p style={styles.step}>
              <strong>1.</strong> Tampermonkey 확장 프로그램을 설치합니다.{' '}
              <a
                href={TAMPERMONKEY_URL}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.storeLink}
              >
                Chrome 웹스토어에서 설치 ↗
              </a>
            </p>
            {/* 유사 이름 확장이 많아 공식 스토어 링크를 직접 준다 */}
            <p style={styles.stepNote}>
              이름이 비슷한 확장이 많습니다. 반드시 위 링크의 공식 Tampermonkey를 설치하세요.
            </p>
            <p style={styles.step}><strong>2.</strong> Tampermonkey에서 새 스크립트를 만들고 아래 코드를 붙여넣습니다.</p>
            <p style={styles.step}><strong>3.</strong> 크롬 주소창에 <strong>chrome://extensions</strong>를 입력한 뒤, Tampermonkey의 <strong>세부정보</strong>에서 <strong>사용자 스크립트 허용</strong>을 켭니다.</p>
            <p style={styles.stepNote}>이 설정을 켜지 않으면 스크립트를 활성화해도 실행되지 않습니다. 항목이 보이지 않는 구버전 크롬은 확장 프로그램 페이지 우측 상단의 <strong>개발자 모드</strong>를 대신 켜세요.</p>
            <p style={styles.step}><strong>4.</strong> 쿠팡 주문 상세 페이지를 방문하면 자동으로 주문이 감지됩니다.</p>
          </div>

          {scriptContent && (
            <div style={styles.codeSection}>
              <div style={styles.codeHeader}>
                <span style={styles.codeTitle}>
                  유저스크립트 (키 포함)
                  {version && <span style={styles.versionBadge}>v{version}</span>}
                </span>
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
  stepNote: {
    fontSize: 12,
    color: '#888',
    margin: '2px 0 6px 14px',
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
  storeLink: {
    color: '#4F46E5',
    fontWeight: 600,
    textDecoration: 'none',
    whiteSpace: 'nowrap' as const,
  },
  versionBadge: {
    marginLeft: 8,
    fontSize: 11,
    fontWeight: 500 as const,
    color: '#4338CA',
    background: '#EEF2FF',
    borderRadius: 4,
    padding: '2px 6px',
    fontFamily: 'monospace',
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
