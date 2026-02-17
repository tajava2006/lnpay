/**
 * NIP-46 로그인 화면
 *
 * 마운트 시 자동으로:
 *   1. 캐시된 릴레이 목록 획득
 *   2. nostrconnect:// URI 생성
 *   3. QR 코드 표시 + 벙커 연결 대기
 *   4. 연결 수립 → 신원 검증 → onLogin 콜백
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { getRelays } from '@sajwo-tracker/shared';
import { storage } from '../nostr/storage';
import {
  createLoginContext,
  waitForConnection,
  verifyIdentity,
  finalizeLogin,
} from '../nostr/nip46';

type LoginState =
  | { phase: 'loading' }                            // 릴레이 목록 획득 중
  | { phase: 'waiting'; uri: string }                // QR 표시 중, 벙커 대기
  | { phase: 'verifying' }                           // 연결됨, 신원 검증 중
  | { phase: 'error'; message: string };             // 에러 발생

/** 벙커 응답 대기 타임아웃 (5분) */
const CONNECTION_TIMEOUT_MS = 5 * 60 * 1000;

interface LoginScreenProps {
  onLogin: () => void;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [state, setState] = useState<LoginState>({ phase: 'loading' });
  const abortRef = useRef<AbortController | null>(null);
  const clientKeyRef = useRef<Uint8Array | null>(null);

  const startLogin = useCallback(async () => {
    // 이전 대기 중단
    abortRef.current?.abort();

    setState({ phase: 'loading' });

    try {
      // 1. 릴레이 목록 획득
      const relays = await getRelays(storage);
      if (relays.length === 0) {
        setState({ phase: 'error', message: '사용 가능한 릴레이를 찾을 수 없습니다.' });
        return;
      }

      // 2. 로그인 컨텍스트 생성
      const { uri, clientSecretKey } = createLoginContext(relays);
      clientKeyRef.current = clientSecretKey;

      // 3. QR 표시 + 타임아웃 설정
      const abort = new AbortController();
      abortRef.current = abort;
      const timeout = setTimeout(() => abort.abort(), CONNECTION_TIMEOUT_MS);

      setState({ phase: 'waiting', uri });

      // 4. 벙커 연결 대기
      let signer;
      try {
        signer = await waitForConnection(clientSecretKey, uri, abort.signal);
      } finally {
        clearTimeout(timeout);
      }

      // 5. 신원 검증
      setState({ phase: 'verifying' });
      await verifyIdentity(signer);

      // 6. 세션 저장 + 완료
      finalizeLogin(signer, clientSecretKey);
      onLogin();
    } catch (err) {
      if (abortRef.current?.signal.aborted) {
        setState({ phase: 'error', message: '연결 대기 시간이 초과되었습니다.' });
      } else {
        const message = err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.';
        setState({ phase: 'error', message });
      }
    }
  }, [onLogin]);

  // 마운트 시 자동 시작
  useEffect(() => {
    startLogin();
    return () => { abortRef.current?.abort(); };
  }, [startLogin]);

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>사줘 트래커 어드민</h1>
        <p style={styles.subtitle}>NIP-46 원격 서명으로 로그인</p>

        {state.phase === 'loading' && (
          <p style={styles.status}>릴레이 연결 준비 중...</p>
        )}

        {state.phase === 'waiting' && (
          <>
            <div style={styles.qrWrapper}>
              <QRCodeSVG value={state.uri} size={240} level="M" />
            </div>
            <p style={styles.instruction}>
              Nostr 벙커 앱으로 QR 코드를 스캔하세요
            </p>
            <details style={styles.details}>
              <summary style={styles.summary}>연결 URI 직접 복사</summary>
              <textarea
                readOnly
                value={state.uri}
                style={styles.uriText}
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              />
            </details>
            <p style={styles.waiting}>벙커 응답 대기 중...</p>
          </>
        )}

        {state.phase === 'verifying' && (
          <p style={styles.status}>신원 검증 중...</p>
        )}

        {state.phase === 'error' && (
          <div style={styles.errorBox}>
            <p style={styles.errorMessage}>{state.message}</p>
            <button style={styles.retryButton} onClick={startLogin}>
              다시 시도
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '80vh',
    padding: 24,
  },
  card: {
    maxWidth: 420,
    width: '100%',
    padding: '40px 32px',
    background: '#fff',
    borderRadius: 16,
    boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
    textAlign: 'center' as const,
  },
  title: {
    fontSize: 24,
    fontWeight: 700 as const,
    color: '#333',
    margin: '0 0 4px',
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    margin: '0 0 32px',
  },
  qrWrapper: {
    display: 'inline-block',
    padding: 16,
    background: '#fff',
    borderRadius: 12,
    border: '1px solid #eee',
    marginBottom: 20,
  },
  instruction: {
    fontSize: 15,
    color: '#555',
    margin: '0 0 16px',
    fontWeight: 500 as const,
  },
  details: {
    marginBottom: 20,
    textAlign: 'left' as const,
  },
  summary: {
    fontSize: 13,
    color: '#888',
    cursor: 'pointer' as const,
  },
  uriText: {
    width: '100%',
    height: 80,
    marginTop: 8,
    padding: 8,
    fontSize: 11,
    fontFamily: 'monospace',
    border: '1px solid #ddd',
    borderRadius: 6,
    resize: 'none' as const,
    color: '#555',
    wordBreak: 'break-all' as const,
  },
  waiting: {
    fontSize: 13,
    color: '#999',
    margin: 0,
  },
  status: {
    fontSize: 14,
    color: '#999',
    padding: '60px 0',
  },
  errorBox: {
    padding: '24px 0',
  },
  errorMessage: {
    fontSize: 14,
    color: '#B91C1C',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap' as const,
    margin: '0 0 20px',
  },
  retryButton: {
    padding: '10px 28px',
    fontSize: 14,
    fontWeight: 600 as const,
    color: '#fff',
    background: '#4F46E5',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer' as const,
  },
} as const;
