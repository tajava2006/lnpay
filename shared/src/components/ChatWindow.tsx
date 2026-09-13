import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import type { AccountInfo } from '../types';

interface Props {
  label: string;
  messages: ChatMessage[];
  myPubkey: string;
  onSend: (text: string) => Promise<void>;
  /** 실패한 메시지 재전송. 없으면 재전송 버튼을 숨긴다. */
  onRetry?: (message: ChatMessage) => Promise<void>;
  /** 계좌 공개 말풍선에 덧붙일 요소. 커밋먼트 검증에 솔트가 필요해 같이 넘긴다. */
  renderAccountExtra?: (accountInfo: AccountInfo, commitmentSalt?: string) => React.ReactNode;
}

export function ChatWindow({ label, messages, myPubkey, onSend, onRetry, renderAccountExtra }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // compositionend가 keydown보다 먼저 오는 엔진이 있어 이벤트 플래그만으론
  // 놓치는 경우가 있다. 조합 구간을 직접 들고 있는다.
  const isComposingRef = useRef(false);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      // onSend는 서명 + 스토어 반영까지만 기다린다(발행은 백그라운드).
      // 그래서 입력창이 곧바로 비워지면서도, 서명이 실패하면 내용이 남는다.
      await onSend(trimmed);
      setText('');
    } catch (err) {
      console.warn('[ChatWindow] 전송 준비 실패:', err);
      alert('메시지를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSending(false);
    }
  };

  const handleRetry = async (msg: ChatMessage) => {
    if (!onRetry) return;
    try {
      await onRetry(msg);
    } catch (err) {
      console.warn('[ChatWindow] 재전송 실패:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 한글 같은 조합 입력에서는 엔터가 두 가지 뜻을 갖는다 — 조합 확정과 전송.
    // 조합 중인 엔터를 전송으로 처리하면, 아직 확정되지 않은 마지막 글자까지
    // 함께 보내놓고 입력창을 비우는데, 그 직후 IME가 그 글자를 커밋하면서
    // 빈 입력창에 다시 들어앉는다. 결과적으로 마지막 글자가 한 번 더 전송된다.
    // (영어는 조합 단계가 없어 이 경로를 타지 않는다)
    //
    // isComposing이 정석이고, keyCode 229는 그 플래그를 제대로 안 주는
    // 구형 엔진용 폴백이다. 둘 중 하나라도 걸리면 IME에 양보한다.
    if (isComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>{label}</div>
      <div ref={listRef} style={styles.messageList}>
        {messages.length === 0 && (
          <div style={styles.empty}>메시지 없음</div>
        )}
        {messages.map(msg => {
          const isMine = msg.senderPubkey === myPubkey;
          return (
            <div key={msg.eventId} style={{
              display: 'flex',
              justifyContent: isMine ? 'flex-end' : 'flex-start',
              marginBottom: 6,
            }}>
              <div style={{
                ...styles.bubble,
                ...(isMine ? styles.mine : styles.theirs),
              }}>
                {msg.payload.type === 'account-reveal' && msg.payload.accountInfo ? (
                  <div style={styles.accountReveal}>
                    <div style={styles.accountLabel}>계좌 정보 공개</div>
                    <div>{msg.payload.accountInfo.bankName}</div>
                    <div>{msg.payload.accountInfo.accountNumber}</div>
                    <div>{msg.payload.accountInfo.holderName}</div>
                    {renderAccountExtra?.(msg.payload.accountInfo, msg.payload.commitmentSalt)}
                  </div>
                ) : (
                  <div style={styles.text}>{msg.payload.content}</div>
                )}
                <div style={styles.time}>
                  {new Date(msg.createdAt * 1000).toLocaleTimeString('ko-KR', {
                    hour: '2-digit', minute: '2-digit',
                  })}
                  {/* 상태는 내가 보낸 것에만 있다. 릴레이에서 받은 건 이미 도달한 것이므로 없다. */}
                  {msg.status === 'pending' && <span style={styles.statusPending}> · 보내는 중</span>}
                  {msg.status === 'sent' && <span style={styles.statusSent}> · 전송됨</span>}
                  {msg.status === 'failed' && (
                    <>
                      <span style={styles.statusFailed}> · 전송 실패</span>
                      {onRetry && (
                        <button
                          type="button"
                          style={styles.retryBtn}
                          onClick={() => void handleRetry(msg)}
                        >
                          재전송
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={styles.inputRow}>
        <textarea
          style={styles.input}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => { isComposingRef.current = false; }}
          placeholder="메시지 입력..."
          rows={1}
        />
        <button
          style={styles.sendBtn}
          onClick={() => void handleSend()}
          disabled={sending || !text.trim()}
        >
          {sending ? '...' : '전송'}
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: {
    border: '1px solid #E5E7EB',
    borderRadius: 8,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  header: {
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600 as const,
    color: '#333',
    background: '#F9FAFB',
    borderBottom: '1px solid #E5E7EB',
  },
  messageList: {
    minHeight: 200,
    maxHeight: 360,
    overflowY: 'auto' as const,
    padding: '12px 16px',
  },
  empty: {
    textAlign: 'center' as const,
    color: '#999',
    fontSize: 13,
    padding: 32,
  },
  bubble: {
    maxWidth: '75%',
    padding: '8px 12px',
    borderRadius: 12,
    fontSize: 13,
    lineHeight: 1.5,
    wordBreak: 'break-word' as const,
  },
  mine: {
    background: '#EEF2FF',
    color: '#333',
    borderBottomRightRadius: 4,
  },
  theirs: {
    background: '#F3F4F6',
    color: '#333',
    borderBottomLeftRadius: 4,
  },
  accountReveal: {
    fontSize: 12,
    lineHeight: 1.6,
  },
  accountLabel: {
    fontWeight: 600 as const,
    color: '#059669',
    marginBottom: 4,
  },
  text: {
    whiteSpace: 'pre-wrap' as const,
  },
  statusPending: {
    opacity: 0.7,
  },
  statusSent: {
    opacity: 0.7,
  },
  statusFailed: {
    color: '#FCA5A5',
    fontWeight: 700 as const,
  },
  retryBtn: {
    marginLeft: 6,
    padding: '0 6px',
    fontSize: 10,
    fontWeight: 700 as const,
    color: '#fff',
    background: 'rgba(0,0,0,0.25)',
    border: '1px solid rgba(255,255,255,0.4)',
    borderRadius: 4,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
  },
  time: {
    fontSize: 10,
    color: '#999',
    marginTop: 4,
    textAlign: 'right' as const,
  },
  inputRow: {
    display: 'flex',
    gap: 8,
    padding: '8px 12px',
    borderTop: '1px solid #E5E7EB',
    background: '#FAFAFA',
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    fontSize: 13,
    border: '1px solid #D1D5DB',
    borderRadius: 8,
    outline: 'none',
    resize: 'none' as const,
    fontFamily: 'inherit',
    lineHeight: 1.4,
  },
  sendBtn: {
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 500 as const,
    color: '#fff',
    background: '#4F46E5',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap' as const,
  },
} as const;
