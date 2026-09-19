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

/**
 * 유저스크립트를 설치할 수 있는 환경인가.
 *
 * Tampermonkey류는 **데스크톱 브라우저 확장**이다. 폰에서는 기본 브라우저에
 * 확장이 없어서 설치 자체가 불가능한데, 설치 안내를 띄우면 유저는 자기가 뭘
 * 잘못하고 있다고 생각한다. 쿠팡 쇼핑은 대개 폰에서 하므로 이 화면을 보는
 * 다수가 그 상태였다.
 *
 * UA 판별은 원래 신뢰할 게 못 되지만, 여기서 거는 건 보안이 아니라 **선택적
 * 편의 기능의 노출 여부**다. 틀려도 안내가 하나 더/덜 보일 뿐이고, 기능은
 * 수동 입력으로 온전히 동작한다.
 *
 * (폰에서도 확장을 지원하는 브라우저가 있긴 하다 — 안드로이드 Firefox·Kiwi,
 * iOS Orion 등. 그 경우 안내가 안 보이지만, 그걸 쓰는 사람은 이미 설치법을 안다.)
 */
export function canInstallUserscript(): boolean {
  return !/Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
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
          {/* 설치를 권하기 전에 무엇을 왜 읽는지부터 밝힌다.
              주문 정보에 접근하는 물건이라 거부감이 드는 게 자연스럽고,
              안 써도 되는 선택지라는 점을 먼저 말하는 쪽이 정직하다. */}
          <div style={styles.intro}>
            <p style={styles.introLead}>이게 뭔가요?</p>
            <p style={styles.introText}>
              쿠팡 주문 상세 페이지를 볼 때 <strong>무통장입금 주문의 금액과 가상계좌를
              자동으로 읽어</strong> 이 앱에 채워 넣는 보조 스크립트입니다.
              직접 옮겨 적는 수고가 사라지고, 무엇보다 <strong>오타가 나지 않습니다.</strong>
            </p>

            <p style={styles.introLead}>꼭 설치해야 하나요?</p>
            <p style={styles.introText}>
              아닙니다. <strong>설치하지 않아도 모든 기능을 쓸 수 있습니다.</strong>
              금액과 계좌를 직접 입력해서 의뢰를 올리면 됩니다.
              내 주문 정보를 읽는 게 찜찜하다면 설치하지 마세요 — 그게 이상한 반응이 아닙니다.
            </p>

            <p style={styles.introLead}>무엇을 읽나요?</p>
            <p style={styles.introText}>
              쿠팡 주문 페이지에서 <strong>입금 금액·은행·계좌번호·예금주·입금 기한</strong>만
              읽습니다. 읽은 값은 <strong>내 키로 암호화되어 나에게만</strong> 전달되고,
              내가 "의뢰 등록"을 눌러야 비로소 오더북에 올라갑니다. 내가 확인하기 전에
              저절로 공개되는 것은 없습니다.
            </p>

            <p style={styles.warnBox}>
              <strong>직접 입력하실 때 주의</strong> — 금액이나 계좌번호에 오타가 있으면
              후원자가 엉뚱한 곳에 송금하게 되고, 그때는 분쟁에서 불리하게 작용할 수 있습니다.
              직접 입력하신다면 등록 전에 한 번 더 대조해 주세요.
            </p>
          </div>

          <div style={styles.stepsTitle}>설치 방법</div>
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
  intro: {
    marginBottom: 16,
    paddingBottom: 12,
    borderBottom: '1px solid #F3F4F6',
  },
  introLead: {
    fontSize: 13,
    fontWeight: 700 as const,
    color: '#374151',
    margin: '10px 0 4px',
  },
  introText: {
    fontSize: 13,
    color: '#555',
    lineHeight: 1.7,
    margin: 0,
  },
  warnBox: {
    fontSize: 12,
    color: '#92400E',
    background: '#FFFBEB',
    border: '1px solid #FDE68A',
    borderRadius: 6,
    padding: '10px 12px',
    lineHeight: 1.7,
    margin: '14px 0 0',
  },
  stepsTitle: {
    fontSize: 13,
    fontWeight: 700 as const,
    color: '#374151',
    marginBottom: 6,
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
