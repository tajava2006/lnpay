/**
 * 분쟁 채팅 — 두 트랙 공용 (PLAN-DAEMON §5.4)
 *
 * 운영자 키로는 APP↔유저 대화를 못 연다. 데몬이 풀어서 이 운영자에게 다시 암호화한 **사본**을 보여주고,
 * 보낼 때는 `chat.send` 명령을 쓴다(데몬이 APP 키로 발행한다). 계좌 공개 메시지는 고객이 계좌를 보낼 때
 * 단 커밋먼트와 대조한다.
 */
import { useState } from 'react';
import { MAX_CHAT_TEXT, type AdminChatCopy, type AdminCommandResult, type TrackName } from '@sajwo-tracker/shared';
import { sendCommand } from '../daemon/client';
import { CommitmentBadge } from './CommitmentBadge';

function time(sec: number): string {
  return new Date(sec * 1000).toLocaleString('ko-KR');
}

function resultText(result: AdminCommandResult | null): string {
  if (!result) return '데몬 응답 없음 — 전달됐는지 모릅니다';
  return result.ok ? '보냄' : `거절: ${result.error}`;
}

export function DisputeChat({ track, orderId, messages, customer, sponsor, accountCommitment }: {
  track: TrackName;
  orderId: string;
  messages: AdminChatCopy[];
  customer: string | undefined;
  sponsor: string | undefined;
  accountCommitment: string | undefined;
}) {
  const [to, setTo] = useState<'customer' | 'sponsor'>('customer');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const recipient = to === 'customer' ? customer : sponsor;

  const roleName = (m: AdminChatCopy) => m.role === 'admin' ? `운영자 → ${m.to === customer ? '고객' : '후원자'}`
    : m.role === 'customer' ? '고객' : m.role === 'sponsor' ? '후원자' : '?';

  return (
    <section style={styles.card}>
      <h3 style={styles.h3}>분쟁 채팅 <span style={styles.note}>{messages.length}건</span></h3>
      {messages.map(m => (
        <div key={m.originalId} style={m.role === 'admin' ? styles.mine : styles.theirs}>
          <div style={styles.note}>{roleName(m)} · {time(m.sentAt)}</div>
          {m.payload.type === 'text' && <div>{m.payload.content}</div>}
          {m.payload.type === 'account-reveal' && m.payload.accountInfo && (
            <div>
              <div>계좌 공개: {m.payload.accountInfo.bankName} {m.payload.accountInfo.accountNumber} ({m.payload.accountInfo.holderName})</div>
              {accountCommitment
                ? <CommitmentBadge accountInfo={m.payload.accountInfo} commitment={accountCommitment} salt={m.payload.commitmentSalt} />
                : <div style={styles.note}>대조할 커밋먼트가 없습니다(고객이 계좌를 보낸 기록이 없음)</div>}
            </div>
          )}
        </div>
      ))}
      <div style={styles.row}>
        <select style={styles.select} value={to} onChange={e => setTo(e.target.value as 'customer' | 'sponsor')}>
          <option value="customer">고객에게</option>
          <option value="sponsor" disabled={!sponsor}>후원자에게</option>
        </select>
        <input
          style={styles.textInput} value={text} maxLength={MAX_CHAT_TEXT} placeholder="메시지"
          onChange={e => setText(e.target.value)}
        />
        <button
          style={styles.button}
          disabled={!recipient || text.trim() === ''}
          onClick={() => {
            setStatus('보내는 중…');
            void sendCommand('chat.send', { track, orderId, to: recipient, text })
              .then(r => { setStatus(resultText(r)); if (r?.ok) setText(''); })
              .catch(e => setStatus(e instanceof Error ? e.message : String(e)));
          }}
        >
          보내기
        </button>
      </div>
      {status && <p style={styles.note}>{status}</p>}
    </section>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column' as const, gap: 12 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const },
  h3: { fontSize: 15, margin: 0, color: '#333', display: 'flex', alignItems: 'baseline', gap: 8 },
  note: { fontSize: 12, color: '#6B7280', margin: 0, fontWeight: 400 as const },
  button: { padding: '8px 14px', fontSize: 13, fontWeight: 600 as const, background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  mine: { alignSelf: 'flex-end', background: '#EEF2FF', borderRadius: 8, padding: '8px 12px', maxWidth: '80%', fontSize: 13 },
  theirs: { alignSelf: 'flex-start', background: '#F3F4F6', borderRadius: 8, padding: '8px 12px', maxWidth: '80%', fontSize: 13 },
  select: { padding: '8px', fontSize: 13, border: '1px solid #D1D5DB', borderRadius: 6 },
  textInput: { flex: 1, minWidth: 160, padding: '8px', fontSize: 13, border: '1px solid #D1D5DB', borderRadius: 6 },
};
