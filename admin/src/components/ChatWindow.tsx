import { useEffect, useRef, useState } from 'react';
import { sha256Hex } from '@sajwo-tracker/shared';
import type { ChatMessage, AccountInfo } from '@sajwo-tracker/shared';

interface Props {
  label: string;
  messages: ChatMessage[];
  myPubkey: string;
  onSend: (text: string) => Promise<void>;
  /** account-info 커밋먼트 해시 (Sponsor 채팅에서만 사용) */
  accountCommitment?: string;
}

/** account-reveal 메시지의 커밋먼트 검증 배지 */
function CommitmentBadge({ accountInfo, commitment }: { accountInfo: AccountInfo; commitment: string }) {
  const [verified, setVerified] = useState<boolean | null>(null);

  useEffect(() => {
    void sha256Hex(JSON.stringify(accountInfo)).then(hash => {
      setVerified(hash === commitment);
    });
  }, [accountInfo, commitment]);

  if (verified === null) return null;
  if (verified) {
    return (
      <div style={{ fontSize: 11, fontWeight: 600, color: '#059669', marginTop: 4 }}>
        &#x2713; 커밋먼트 검증 완료
      </div>
    );
  }
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: '#DC2626', marginTop: 4 }}>
      &#x26A0; 커밋먼트 불일치
    </div>
  );
}

export function ChatWindow({ label, messages, myPubkey, onSend, accountCommitment }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText('');
    } catch (err) {
      console.warn('[ChatWindow] send failed:', err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
                    {accountCommitment && (
                      <CommitmentBadge
                        accountInfo={msg.payload.accountInfo}
                        commitment={accountCommitment}
                      />
                    )}
                  </div>
                ) : (
                  <div style={styles.text}>{msg.payload.content}</div>
                )}
                <div style={styles.time}>
                  {new Date(msg.createdAt * 1000).toLocaleTimeString('ko-KR', {
                    hour: '2-digit', minute: '2-digit',
                  })}
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
