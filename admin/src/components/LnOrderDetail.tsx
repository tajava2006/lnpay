/**
 * 라이트닝 오더 상세 · 분쟁 (PLAN-DAEMON §6)
 *
 * 공개 오더(누구나 보는 것)와 데몬이 이 운영자에게만 보낸 상세(인보이스 상태·버전·지급 오류·계좌
 * 커밋먼트)를 나란히 보여주고, 명령을 보낸다. **판정 버튼은 상세의 버전을 싣는다** — 다른 기기에서 이미
 * 바뀌었으면 데몬이 거절한다(DM-006). 상세가 아직 없으면 명령을 못 보낸다.
 *
 * 채팅은 데몬이 중계한 사본이다(운영자 키로는 APP↔유저 대화를 못 연다, §5.4).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { nip19 } from 'nostr-tools';
import {
  MAX_CHAT_TEXT, stateDisplay,
  type AdminChatCopy, type AdminCommandResult, type AdminLnOrderDetail, type Order,
} from '@sajwo-tracker/shared';
import { LN_CLOSE_REASON_LABEL, isLnCloseReason } from '@sajwo-tracker/shared/ln';
import { sendCommand } from '../daemon/client';
import { chats, lnDetails, lnOrders } from '../daemon/stores';
import { CommitmentBadge } from './CommitmentBadge';

const INVOICE_PURPOSE: Record<AdminLnOrderDetail['invoices'][number]['purpose'], string> = {
  escrow: '에스크로',
  'customer-deposit': '고객 보증금',
  'sponsor-deposit': '후원자 보증금',
};

const INVOICE_STATUS: Record<AdminLnOrderDetail['invoices'][number]['status'], string> = {
  creating: '만드는 중',
  open: '결제 대기',
  accepted: '잡힘',
  settled: '받음',
  cancelled: '취소·환불',
};

function short(pubkey: string | undefined): string {
  return pubkey ? `${nip19.npubEncode(pubkey).slice(0, 14)}…` : '—';
}

function time(sec: number | undefined): string {
  return sec ? new Date(sec * 1000).toLocaleString('ko-KR') : '—';
}

function resultText(result: AdminCommandResult | null): string {
  if (!result) return '데몬 응답 없음 — 집행됐는지 모릅니다. 상세가 갱신되는지 보고 판단하세요';
  if (result.ok) return '완료';
  return result.error === 'stale-version'
    ? '거절: 그 사이 오더가 바뀌었습니다(다른 기기 또는 유저). 상세를 다시 보고 판단하세요'
    : `거절: ${result.error}`;
}

export function LnOrderDetail({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const order = useSyncExternalStore(lnOrders.subscribe, lnOrders.get)[orderId];
  const view = useSyncExternalStore(lnDetails.subscribe, lnDetails.get)[orderId];
  const messages = useSyncExternalStore(chats.subscribe, chats.get)[`ln:${orderId}`] ?? [];
  const detail = view?.detail;

  // 상세가 없으면(새 기기·보존 기간 지남) 데몬에게 다시 내 달라고 한다 — 한 번만
  useEffect(() => {
    if (!detail) void sendCommand('ln.detail', { orderId });
  }, [orderId, detail]);

  const state = detail?.state ?? order?.state;
  const display = state ? stateDisplay(state) : null;

  return (
    <div style={styles.column}>
      <button style={styles.back} onClick={onBack}>← 목록</button>
      <section style={styles.card}>
        <div style={styles.row}>
          <h2 style={styles.h2}><span style={styles.mono}>{orderId}</span></h2>
          {display && <span style={{ ...styles.badge, color: display.color, background: display.bg }}>{display.label}</span>}
          {detail?.pendingClose && <span style={{ ...styles.badge, ...styles.pending }}>닫는 중 · {reasonLabel(detail.pendingClose)}</span>}
        </div>
        <Summary order={order} detail={detail} />
      </section>

      {detail ? <Invoices detail={detail} /> : (
        <section style={styles.card}><p style={styles.note}>데몬 상세를 기다리는 중… (명령은 상세가 와야 보낼 수 있습니다)</p></section>
      )}
      {detail && <Actions detail={detail} />}
      <Chat orderId={orderId} detail={detail} order={order} messages={messages} />
    </div>
  );
}

function reasonLabel(reason: string): string {
  return isLnCloseReason(reason) ? LN_CLOSE_REASON_LABEL[reason] : reason;
}

function Summary({ order, detail }: { order: Order | undefined; detail: AdminLnOrderDetail | undefined }) {
  const price = detail?.price ?? order?.price;
  const deadline = detail?.deadline ?? order?.expiration;
  return (
    <dl style={styles.dl}>
      <dt>금액</dt><dd>{price ? `${price.toLocaleString()}원` : '—'}{detail?.payoutSat ? ` · 지급 ${detail.payoutSat.toLocaleString()} sats` : ''}</dd>
      <dt>쿠팡 기한</dt><dd>{time(deadline)}</dd>
      <dt>고객</dt><dd style={styles.mono}>{short(detail?.customer ?? order?.customerPubkey)}</dd>
      <dt>후원자</dt><dd style={styles.mono}>{short(detail?.sponsor ?? order?.sponsorPubkey)}</dd>
      {detail && <>
        <dt>버전</dt><dd>{detail.version} <span style={styles.note}>· 갱신 {time(detail.updatedAt)}</span></dd>
        {detail.closeReason && <><dt>종결 사유</dt><dd>{reasonLabel(detail.closeReason)}</dd></>}
        <dt>지급</dt>
        <dd>
          {detail.disbursed ? '완료' : detail.sponsorInvoice ? '대기' : '인보이스 없음'}
          {detail.payoutError && <span style={styles.warnText}> · 오류: {detail.payoutError}</span>}
        </dd>
        {detail.escrowSettled && !detail.disbursed && <><dt>에스크로</dt><dd style={styles.warnText}>이미 받음(선제 정산) — 판정이 필요합니다</dd></>}
        <dt>계좌 전달</dt>
        <dd>{detail.accountSentAt ? `${time(detail.accountSentAt)} · 커밋먼트 ${detail.accountCommitment?.slice(0, 12)}…` : '—'}</dd>
        {detail.remittedAt && <><dt>송금 완료</dt><dd>{time(detail.remittedAt)}</dd></>}
      </>}
    </dl>
  );
}

function Invoices({ detail }: { detail: AdminLnOrderDetail }) {
  if (detail.invoices.length === 0) return null;
  return (
    <section style={styles.card}>
      <h3 style={styles.h3}>홀드 인보이스 {detail.blockHeight && <span style={styles.note}>· 블록 {detail.blockHeight.toLocaleString()}</span>}</h3>
      <table style={styles.table}>
        <thead><tr><th style={styles.th}>무엇</th><th style={styles.th}>금액</th><th style={styles.th}>상태</th><th style={styles.th}>결제 기한</th><th style={styles.th}>HTLC 만기</th></tr></thead>
        <tbody>
          {detail.invoices.map((inv, i) => (
            <tr key={i}>
              <td style={styles.td}>{INVOICE_PURPOSE[inv.purpose]}</td>
              <td style={styles.td}>{inv.amountSat.toLocaleString()} sats</td>
              <td style={styles.td}>{INVOICE_STATUS[inv.status]}</td>
              <td style={styles.td}>{time(inv.payBy)}</td>
              <td style={styles.td}>
                {inv.htlcExpiryHeight
                  ? `${inv.htlcExpiryHeight.toLocaleString()}${detail.blockHeight ? ` (${inv.htlcExpiryHeight - detail.blockHeight}블록 남음)` : ''}`
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

interface ActionSpec {
  cmd: string;
  label: string;
  args?: Record<string, unknown>;
  /** 누르기 전에 묻는다 — 되돌릴 수 없는 것 */
  confirm?: string;
  danger?: boolean;
}

function actionsFor(d: AdminLnOrderDetail): ActionSpec[] {
  if (d.pendingClose) return [];
  const list: ActionSpec[] = [];
  if (d.state === 'claimed') {
    list.push({ cmd: 'ln.approve', label: '승인' });
    list.push({ cmd: 'ln.revert-claim', label: '클레임 되돌리기', confirm: '후원자를 떼고 다시 오더북에 올립니다. 후원자 보증금은 돌려줍니다.' });
  }
  if (d.state === 'escrowed' || d.state === 'invoiced') {
    list.push({
      cmd: 'ln.force-close', label: '강제 종결', danger: true,
      confirm: d.state === 'invoiced'
        ? '계좌가 이미 나갔습니다. 후원자가 송금해 놓고 버튼만 안 눌렀을 수 있습니다. 에스크로를 고객에게 돌려주고 끝낼까요?'
        : '에스크로를 고객에게 돌려주고 끝냅니다. 보증금은 양쪽 다 돌려줍니다.',
    });
  }
  if (d.state === 'remitted') {
    list.push({ cmd: 'ln.rule', label: '후원자 승 (지급)', args: { winner: 'sponsor' }, confirm: '에스크로를 받아 후원자에게 지급합니다. 되돌릴 수 없습니다.' });
    list.push({
      cmd: 'ln.rule', label: '고객 승 (환불)', args: { winner: 'customer' }, danger: true,
      confirm: d.escrowSettled
        ? '에스크로가 이미 정산돼 있어 자동 환불이 안 됩니다 — 고객에게 손으로 환불해야 합니다. 후원자 보증금은 몰수됩니다. 진행할까요?'
        : '에스크로를 고객에게 돌려주고 후원자 보증금을 몰수합니다. 되돌릴 수 없습니다.',
    });
  }
  if ((d.state === 'paid' || d.state === 'sponsor_wins') && !d.disbursed) {
    list.push({ cmd: 'ln.retry-payout', label: '지급 지금 다시' });
  }
  if (d.sponsor && d.accountCommitment && !['paid', 'cancelled', 'expired', 'admin_closed'].includes(d.state)) {
    list.push({ cmd: 'ln.reveal-request', label: '후원자에게 계좌 공개 요청' });
  }
  return list;
}

function Actions({ detail }: { detail: AdminLnOrderDetail }) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = actionsFor(detail);
  if (actions.length === 0) return null;

  const run = (a: ActionSpec) => {
    if (a.confirm && !window.confirm(a.confirm)) return;
    setBusy(true);
    setStatus('보내는 중…');
    const target = { track: 'ln', orderId: detail.orderId, version: detail.version };
    void sendCommand(a.cmd, { ...a.args, target })
      .then(r => setStatus(resultText(r)))
      .catch(e => setStatus(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section style={styles.card}>
      <h3 style={styles.h3}>명령 <span style={styles.note}>버전 {detail.version} 기준</span></h3>
      <div style={styles.row}>
        {actions.map(a => (
          <button key={`${a.cmd}:${a.label}`} disabled={busy} style={a.danger ? styles.danger : styles.button} onClick={() => run(a)}>
            {a.label}
          </button>
        ))}
      </div>
      {status && <p style={styles.note}>{status}</p>}
    </section>
  );
}

function Chat({ orderId, detail, order, messages }: {
  orderId: string; detail: AdminLnOrderDetail | undefined; order: Order | undefined; messages: AdminChatCopy[];
}) {
  const customer = detail?.customer ?? order?.customerPubkey;
  const sponsor = detail?.sponsor ?? order?.sponsorPubkey;
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
              {detail?.accountCommitment
                ? <CommitmentBadge accountInfo={m.payload.accountInfo} commitment={detail.accountCommitment} salt={m.payload.commitmentSalt} />
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
            void sendCommand('chat.send', { track: 'ln', orderId, to: recipient, text })
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
  column: { display: 'flex', flexDirection: 'column' as const, gap: 16 },
  card: { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column' as const, gap: 12 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const },
  h2: { fontSize: 17, margin: 0, color: '#333' },
  h3: { fontSize: 15, margin: 0, color: '#333', display: 'flex', alignItems: 'baseline', gap: 8 },
  back: { alignSelf: 'flex-start', padding: '6px 12px', fontSize: 13, background: '#fff', color: '#374151', border: '1px solid #E5E7EB', borderRadius: 6, cursor: 'pointer' },
  badge: { padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600 as const },
  pending: { background: '#FEF3C7', color: '#92400E' },
  dl: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: 0, fontSize: 13, color: '#374151', wordBreak: 'break-all' as const },
  note: { fontSize: 12, color: '#6B7280', margin: 0, fontWeight: 400 as const },
  warnText: { color: '#B45309' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th: { textAlign: 'left' as const, fontSize: 12, color: '#6B7280', padding: '6px 8px', borderBottom: '1px solid #E5E7EB' },
  td: { padding: '8px', borderBottom: '1px solid #F3F4F6' },
  button: { padding: '8px 14px', fontSize: 13, fontWeight: 600 as const, background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  danger: { padding: '8px 14px', fontSize: 13, fontWeight: 600 as const, background: '#DC2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  mine: { alignSelf: 'flex-end', background: '#EEF2FF', borderRadius: 8, padding: '8px 12px', maxWidth: '80%', fontSize: 13 },
  theirs: { alignSelf: 'flex-start', background: '#F3F4F6', borderRadius: 8, padding: '8px 12px', maxWidth: '80%', fontSize: 13 },
  select: { padding: '8px', fontSize: 13, border: '1px solid #D1D5DB', borderRadius: 6 },
  textInput: { flex: 1, minWidth: 160, padding: '8px', fontSize: 13, border: '1px solid #D1D5DB', borderRadius: 6 },
};
