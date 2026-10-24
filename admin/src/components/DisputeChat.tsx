/**
 * 분쟁 채팅 — 두 트랙 공용
 *
 * 운영자 키로는 APP↔유저 대화를 못 연다. 데몬이 풀어서 이 운영자에게 다시 암호화한 **사본**을 보여주고,
 * 보낼 때는 `chat.send` 명령을 쓴다(데몬이 APP 키로 발행한다). 계좌 공개 메시지는 고객이 계좌를 보낼 때
 * 단 커밋먼트와 대조한다.
 *
 * **고객·후원자 대화를 나눠 그린다** (2026-09-24 드릴). 유저 쪽에서는 각자 운영자와 1:1이다 — 서로의
 * 말을 못 본다. 한 줄에 섞어 두면 누구에게 한 말인지 되짚어야 하고, 보낼 때 받는 사람을 고르다 틀린다.
 * 그래서 대화마다 입력칸이 따로다. 지금 참여자가 아닌 사람과의 대화(풀린 클레임의 옛 후원자)는 따로 남긴다.
 *
 * **세 번째 창 = 두 사람 대화**(docs/PLAN-PEER-CHAT.md §9). 고객과 후원자는 운영자가 못 읽는 상대방 채팅으로 이야기한다.
 * 한쪽이 운영자를 부르면(`call`) 그 거래의 대화 키가 사본에 실려 오고, 그 키로 릴레이의 원본을 받아 **읽기만** 한다.
 * 부르기 전엔 비어 있다 — 운영자는 그 대화를 볼 수 없다.
 */
import { useEffect, useState } from 'react';
import {
  MAX_CHAT_TEXT, dateTimeText, isPeerChatKeyHex, type AdminChatCopy, type TrackName,
} from '@sajwo-tracker/shared';
import { subscribePeerTranscript, type TranscriptMessage } from '../nostr/peer-transcript';
import { sendCommand } from '../daemon/client';
import { commandResultText } from '../format';
import { CommitmentBadge } from './CommitmentBadge';
import { ui } from '../ui';

/** 이 사람과 운영자 사이의 메시지인가 — 운영자가 보낸 건 받는 사람, 유저가 보낸 건 보낸 사람으로 가른다 */
function withParty(m: AdminChatCopy, pubkey: string | undefined): boolean {
  return pubkey !== undefined && (m.from === pubkey || m.to === pubkey);
}

/** 대화 셋으로 가른다 — 고객 · 후원자 · 지금 참여자가 아닌 사람(풀린 클레임의 옛 후원자) */
export function splitThreads(messages: AdminChatCopy[], customer: string | undefined, sponsor: string | undefined) {
  return {
    customer: messages.filter(m => withParty(m, customer)),
    sponsor: messages.filter(m => withParty(m, sponsor)),
    others: messages.filter(m => !withParty(m, customer) && !withParty(m, sponsor)),
  };
}

/** 대화 키를 넘긴 부르기 — 지금 당사자가 보낸 첫 것. 옛 후원자나 모양이 틀린 키는 안 쓴다 */
export function findDisclosure(
  messages: readonly AdminChatCopy[], customer: string | undefined, sponsor: string | undefined,
): { keyHex: string; by: 'customer' | 'sponsor'; at: number } | null {
  for (const m of messages) {
    if (m.payload.type !== 'call' || !isPeerChatKeyHex(m.payload.peerChatKey)) continue;
    if (customer !== undefined && m.from === customer) return { keyHex: m.payload.peerChatKey, by: 'customer', at: m.sentAt };
    if (sponsor !== undefined && m.from === sponsor) return { keyHex: m.payload.peerChatKey, by: 'sponsor', at: m.sentAt };
  }
  return null;
}

/** 이 오더에 운영자 부르기가 있었나 — 목록의 "호출" 표시 */
export const hasCall = (messages: readonly AdminChatCopy[] | undefined): boolean =>
  !!messages?.some(m => m.payload.type === 'call');

export function DisputeChat({ track, orderId, messages, customer, sponsor, accountCommitment }: {
  track: TrackName;
  orderId: string;
  messages: AdminChatCopy[];
  customer: string | undefined;
  sponsor: string | undefined;
  accountCommitment: string | undefined;
}) {
  const threads = splitThreads(messages, customer, sponsor);
  const disclosure = findDisclosure(messages, customer, sponsor);

  return (
    <section style={ui.card}>
      <h3 style={ui.h3}>대화 <span style={ui.note}>운영자 채팅 {messages.length}건{hasCall(messages) ? ' · 호출 있음' : ''}</span></h3>
      <div style={styles.threads}>
        <Thread
          title="고객" speaker="고객" track={track} orderId={orderId} party={customer}
          messages={threads.customer} accountCommitment={accountCommitment}
        />
        <Thread
          title="후원자" speaker="후원자" track={track} orderId={orderId} party={sponsor}
          messages={threads.sponsor} accountCommitment={accountCommitment}
        />
        {disclosure && customer && sponsor ? (
          <PeerTranscript track={track} orderId={orderId} customer={customer} sponsor={sponsor} disclosure={disclosure} />
        ) : (
          <div style={styles.thread}>
            <div style={styles.threadHead}><b>두 사람 대화</b><span style={ui.note}>공개 안 됨</span></div>
            <p style={ui.note}>고객과 후원자가 나눈 대화는 운영자가 못 봅니다. 한쪽이 운영자를 부르면 여기 펼쳐집니다(읽기만).</p>
          </div>
        )}
      </div>
      {threads.others.length > 0 && (
        <Thread
          title="지금 참여자가 아닌 사람" speaker={null} track={track} orderId={orderId} party={undefined}
          messages={threads.others} accountCommitment={accountCommitment}
        />
      )}
    </section>
  );
}

function Thread({ title, speaker, track, orderId, party, messages, accountCommitment }: {
  title: string;
  /** 유저 쪽 말한 사람 이름. null이면 pubkey 앞자리로 */
  speaker: string | null;
  track: TrackName;
  orderId: string;
  /** 받는 사람. 없으면 읽기만 한다(아직 후원자가 없음 · 옛 참여자) */
  party: string | undefined;
  messages: AdminChatCopy[];
  accountCommitment: string | undefined;
}) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  return (
    <div style={styles.thread}>
      <div style={styles.threadHead}>
        <b>{title}</b>
        <span style={ui.note}>{party ? `${party.slice(0, 8)}… · ${messages.length}건` : `${messages.length}건`}</span>
      </div>
      <div style={styles.messages}>
        {messages.length === 0 && <p style={ui.note}>{party ? '대화 없음' : '아직 없음'}</p>}
        {messages.map(m => (
          <div key={m.originalId} style={m.role === 'admin' ? styles.mine : styles.theirs}>
            <div style={ui.note}>
              {m.role === 'admin' ? '운영자' : speaker ?? m.from.slice(0, 8)} · {dateTimeText(m.sentAt)}
            </div>
            {m.payload.type === 'text' && <div>{m.payload.content}</div>}
            {m.payload.type === 'call' && (
              // 대화 키는 그리지 않는다 — 세 번째 창이 쓴다
              <div>
                <b style={styles.call}>운영자 호출{m.payload.peerChatKey ? ' · 두 사람 대화 공개' : ''}</b>
                <div>{m.payload.reason}</div>
              </div>
            )}
            {m.payload.type === 'account-reveal' && m.payload.accountInfo && (
              <div>
                <div>계좌 공개: {m.payload.accountInfo.bankName} {m.payload.accountInfo.accountNumber} ({m.payload.accountInfo.holderName})</div>
                {accountCommitment
                  ? <CommitmentBadge accountInfo={m.payload.accountInfo} commitment={accountCommitment} salt={m.payload.commitmentSalt} />
                  : <div style={ui.note}>대조할 커밋먼트가 없습니다(고객이 계좌를 보낸 기록이 없음)</div>}
              </div>
            )}
          </div>
        ))}
      </div>
      {party && (
        <div style={styles.row}>
          <input
            style={styles.textInput} value={text} maxLength={MAX_CHAT_TEXT} placeholder={`${title}에게`}
            onChange={e => setText(e.target.value)}
          />
          <button
            style={ui.button}
            disabled={text.trim() === ''}
            onClick={() => {
              setStatus('보내는 중…');
              void sendCommand('chat.send', { track, orderId, to: party, text })
                .then(r => { setStatus(commandResultText(r, { done: '보냄', unknown: '전달됐는지 모릅니다' })); if (r?.ok) setText(''); })
                .catch(e => setStatus(e instanceof Error ? e.message : String(e)));
            }}
          >
            보내기
          </button>
        </div>
      )}
      {status && <p style={ui.note}>{status}</p>}
    </div>
  );
}

/** 세 번째 창 — 공개된 두 사람 대화, 읽기만 */
function PeerTranscript({ track, orderId, customer, sponsor, disclosure }: {
  track: TrackName;
  orderId: string;
  customer: string;
  sponsor: string;
  disclosure: NonNullable<ReturnType<typeof findDisclosure>>;
}) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { keyHex } = disclosure;

  useEffect(() => {
    let alive = true;
    let stop: (() => void) | null = null;
    setMessages([]);
    setUnreadable([]);
    subscribePeerTranscript({ track, orderId, customer, sponsor, keyHex }, {
      message: m => setMessages(prev => (prev.some(x => x.id === m.id) ? prev : [...prev, m].sort((a, b) => a.createdAt - b.createdAt))),
      unreadable: id => setUnreadable(prev => (prev.includes(id) ? prev : [...prev, id])),
    }).then(s => { if (alive) stop = s; else s(); }, (e: unknown) => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      alive = false;
      stop?.();
    };
  }, [track, orderId, customer, sponsor, keyHex]);

  const who = (pubkey: string) => (pubkey === customer ? '고객' : '후원자');

  return (
    <div style={{ ...styles.thread, ...styles.transcript }}>
      <div style={styles.threadHead}>
        <b>두 사람 대화 (읽기만)</b>
        <span style={ui.note}>{messages.length}건</span>
      </div>
      <p style={ui.note}>
        {disclosure.by === 'customer' ? '고객이' : '후원자가'} {dateTimeText(disclosure.at)}에 운영자를 부르며 공개했습니다. 릴레이의
        원본을 서명과 함께 확인한 것만 보입니다.
      </p>
      {error && <p style={ui.note}>불러오지 못했습니다: {error}</p>}
      <div style={styles.messages}>
        {messages.length === 0 && <p style={ui.note}>아직 받은 메시지가 없습니다</p>}
        {messages.map(m => (
          <div key={m.id} style={m.from === customer ? styles.theirs : styles.peerSponsor}>
            <div style={ui.note}>{who(m.from)} · {dateTimeText(m.createdAt)}</div>
            <div style={styles.pre}>{m.text}</div>
          </div>
        ))}
      </div>
      {unreadable.length > 0 && <p style={ui.note}>풀 수 없는 메시지 {unreadable.length}건 — 이 키로 열리지 않거나 서명이 맞지 않습니다</p>}
    </div>
  );
}

const styles = {
  threads: { display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'stretch' },
  thread: {
    flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column' as const, gap: 8,
    border: '1px solid #E5E7EB', borderRadius: 10, padding: 12,
  },
  threadHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 13 },
  messages: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  mine: { alignSelf: 'flex-end', background: '#EEF2FF', borderRadius: 8, padding: '8px 12px', maxWidth: '85%', fontSize: 13, overflowWrap: 'anywhere' as const },
  theirs: { alignSelf: 'flex-start', background: '#F3F4F6', borderRadius: 8, padding: '8px 12px', maxWidth: '85%', fontSize: 13, overflowWrap: 'anywhere' as const },
  textInput: { flex: 1, minWidth: 0, padding: '8px', fontSize: 13, border: '1px solid #D1D5DB', borderRadius: 6 },
  call: { color: '#B45309' },
  transcript: { background: '#FAFAFF', borderColor: '#C7D2FE' },
  peerSponsor: { alignSelf: 'flex-end', background: '#E0E7FF', borderRadius: 8, padding: '8px 12px', maxWidth: '85%', fontSize: 13, overflowWrap: 'anywhere' as const },
  pre: { whiteSpace: 'pre-wrap' as const },
};
