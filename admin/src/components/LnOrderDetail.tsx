/**
 * 라이트닝 오더 상세 · 분쟁
 *
 * 공개 오더(누구나 보는 것)와 데몬이 이 운영자에게만 보낸 상세(인보이스 상태·버전·지급 오류·계좌
 * 커밋먼트)를 나란히 보여주고, 명령을 보낸다. **판정 버튼은 상세의 버전을 싣는다** — 다른 기기에서 이미
 * 바뀌었으면 데몬이 거절한다(DM-006). 상세가 아직 없으면 명령을 못 보낸다.
 *
 * 채팅은 데몬이 중계한 사본이다(운영자 키로는 APP↔유저 대화를 못 연다).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { dateTimeText, lnOrderDisplay, type AdminLnOrderDetail, type Order } from '@sajwo-tracker/shared';
import { LN_CLOSE_REASON_LABEL, isLnCloseReason } from '@sajwo-tracker/shared/ln';
import { sendCommand } from '../daemon/client';
import { chats, lnDetails, lnOrders } from '../daemon/stores';
import { WAITING_DETAIL_TEXT, commandResultText, shortNpub } from '../format';
import { DisputeChat } from './DisputeChat';
import { ui } from '../ui';

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
  // 보증금 대기는 공개 오더가 싣는다 — 상태가 아직 claimed일 때만 먹는다
  const display = state ? lnOrderDisplay({ state, sponsorDepositPending: order?.sponsorDepositPending }) : null;

  return (
    <div style={ui.column}>
      <button style={ui.back} onClick={onBack}>← 목록</button>
      <section style={ui.card}>
        <div style={ui.row}>
          <h2 style={ui.h2}><span style={styles.mono}>{orderId}</span></h2>
          {display && <span style={{ ...ui.badge, color: display.color, background: display.bg }}>{display.label}</span>}
          {detail?.pendingClose && <span style={{ ...ui.badge, ...styles.pending }}>닫는 중 · {reasonLabel(detail.pendingClose)}</span>}
        </div>
        <Summary order={order} detail={detail} />
      </section>

      {detail ? <Invoices detail={detail} /> : (
        <section style={ui.card}><p style={ui.note}>{WAITING_DETAIL_TEXT}</p></section>
      )}
      {detail && <Actions detail={detail} />}
      <DisputeChat
        track="ln" orderId={orderId} messages={messages}
        customer={detail?.customer ?? order?.customerPubkey} sponsor={detail?.sponsor ?? order?.sponsorPubkey}
        accountCommitment={detail?.accountCommitment}
      />
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
    <dl style={ui.dl}>
      <dt>금액</dt><dd>{price ? `${price.toLocaleString()}원` : '—'}{detail?.payoutSat ? ` · 지급 ${detail.payoutSat.toLocaleString()} sats` : ''}</dd>
      <dt>쿠팡 기한</dt><dd>{dateTimeText(deadline)}</dd>
      <dt>고객</dt><dd style={styles.mono}>{shortNpub(detail?.customer ?? order?.customerPubkey)}</dd>
      <dt>후원자</dt><dd style={styles.mono}>{shortNpub(detail?.sponsor ?? order?.sponsorPubkey)}</dd>
      {detail && <>
        <dt>버전</dt><dd>{detail.version} <span style={ui.note}>· 갱신 {dateTimeText(detail.updatedAt)}</span></dd>
        {detail.closeReason && <><dt>종결 사유</dt><dd>{reasonLabel(detail.closeReason)}</dd></>}
        <dt>지급</dt>
        <dd>
          {detail.disbursed ? '완료' : detail.sponsorInvoice ? '대기' : '인보이스 없음'}
          {detail.payoutError && <span style={ui.warnText}> · 오류: {detail.payoutError}</span>}
        </dd>
        {detail.escrowSettled && !detail.disbursed && <><dt>에스크로</dt><dd style={ui.warnText}>이미 받음(선제 정산) — 판정이 필요합니다</dd></>}
        <dt>계좌 전달</dt>
        <dd>{detail.accountSentAt ? `${dateTimeText(detail.accountSentAt)} · 커밋먼트 ${detail.accountCommitment?.slice(0, 12)}…` : '—'}</dd>
        {detail.remittedAt && <><dt>송금 완료</dt><dd>{dateTimeText(detail.remittedAt)}</dd></>}
      </>}
    </dl>
  );
}

function Invoices({ detail }: { detail: AdminLnOrderDetail }) {
  if (detail.invoices.length === 0) return null;
  return (
    <section style={ui.card}>
      <h3 style={ui.h3}>홀드 인보이스 {detail.blockHeight && <span style={ui.note}>· 블록 {detail.blockHeight.toLocaleString()}</span>}</h3>
      <table style={ui.table}>
        <thead><tr><th style={ui.th}>무엇</th><th style={ui.th}>금액</th><th style={ui.th}>상태</th><th style={ui.th}>결제 기한</th><th style={ui.th}>HTLC 만기</th></tr></thead>
        <tbody>
          {detail.invoices.map((inv, i) => (
            <tr key={i}>
              <td style={ui.td}>{INVOICE_PURPOSE[inv.purpose]}</td>
              <td style={ui.td}>{inv.amountSat.toLocaleString()} sats</td>
              <td style={ui.td}>{INVOICE_STATUS[inv.status]}</td>
              <td style={ui.td}>{dateTimeText(inv.payBy)}</td>
              <td style={ui.td}>
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
      .then(r => setStatus(commandResultText(r)))
      .catch(e => setStatus(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section style={ui.card}>
      <h3 style={ui.h3}>명령 <span style={ui.note}>버전 {detail.version} 기준</span></h3>
      <div style={ui.row}>
        {actions.map(a => (
          <button key={`${a.cmd}:${a.label}`} disabled={busy} style={a.danger ? ui.danger : ui.button} onClick={() => run(a)}>
            {a.label}
          </button>
        ))}
      </div>
      {status && <p style={ui.note}>{status}</p>}
    </section>
  );
}

const styles = {
  pending: { background: '#FEF3C7', color: '#92400E' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
};
