/**
 * 온체인 오더 상세 · 판정 · 구조 (PLAN-DAEMON §6 · PLAN-ONCHAIN-TRACK §9)
 *
 * 사람이 판단하는 건 셋뿐이다 — **분쟁 판정, 계좌 이의 판정, 구조.** 나머지(가격 고정·마감·환불 결정·
 * 브로드캐스트·재촉)는 데몬 워처가 한다. 버튼은 전부 데몬 상세의 **버전**을 싣는다 — 다른 기기에서 이미
 * 판정했으면 데몬이 거절한다(DM-006).
 *
 * 여기에는 어드민 키가 없다. 서명은 데몬이 시드에서 파생한 키로 **마지막에** 한다.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { nip19 } from 'nostr-tools';
import type { AdminCommandResult, AdminOcOrderDetail } from '@sajwo-tracker/shared';
import {
  OUTCOME_RULES, currentOnchainDeadline, onchainStateDisplay, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { sendCommand } from '../daemon/client';
import { chats, ocDetails, onchainOrders } from '../daemon/stores';
import { DisputeChat } from './DisputeChat';

const BOND_STATUS: Record<AdminOcOrderDetail['bonds'][number]['status'], string> = {
  creating: '만드는 중',
  open: '결제 대기',
  accepted: '잡힘',
  settled: '몰수',
  cancelled: '환불·만료',
};

function short(pubkey: string | undefined): string {
  return pubkey ? `${nip19.npubEncode(pubkey).slice(0, 14)}…` : '—';
}

function time(sec: number | undefined): string {
  return sec ? new Date(sec * 1000).toLocaleString('ko-KR') : '—';
}

function sats(n: number | undefined): string {
  return n === undefined ? '—' : `${n.toLocaleString()} sats`;
}

function resultText(result: AdminCommandResult | null): string {
  if (!result) return '데몬 응답 없음 — 집행됐는지 모릅니다. 상세가 갱신되는지 보고 판단하세요';
  if (result.ok) return '완료';
  switch (result.error) {
    case 'stale-version': return '거절: 그 사이 오더가 바뀌었습니다(다른 기기 또는 체인). 상세를 다시 보고 판단하세요';
    case 'no-fees': return '거절: 데몬이 네트워크 수수료를 아직 모릅니다 — 잠시 후 다시';
    default: return `거절: ${result.error}`;
  }
}

export function OnchainOrderDetail({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const publicOrder = useSyncExternalStore(onchainOrders.subscribe, onchainOrders.get)[orderId];
  const view = useSyncExternalStore(ocDetails.subscribe, ocDetails.get)[orderId];
  const messages = useSyncExternalStore(chats.subscribe, chats.get)[`onchain:${orderId}`] ?? [];
  const detail = view?.detail;
  const order: Omit<OnchainOrder, 'raw'> | undefined = detail?.order ?? publicOrder;

  useEffect(() => {
    if (!detail) void sendCommand('oc.detail', { orderId });
  }, [orderId, detail]);

  if (!order) return <p style={styles.note}>오더를 불러오는 중…</p>;
  const display = onchainStateDisplay(order.state);
  const deadline = currentOnchainDeadline(order);

  return (
    <div style={styles.column}>
      <button style={styles.back} onClick={onBack}>← 목록</button>
      <section style={styles.card}>
        <div style={styles.row}>
          <h2 style={styles.h2}><span style={styles.mono}>{orderId}</span></h2>
          <span style={{ ...styles.badge, color: display.color, background: display.bg }}>{display.label}</span>
          <span style={styles.note}>{order.network}</span>
        </div>
        <dl style={styles.dl}>
          <dt>금액</dt><dd>{sats(order.amountSat)}{order.priceKrw ? ` · 고정가 ${order.priceKrw.toLocaleString()}원` : ''}</dd>
          {order.reserveKrw && <><dt>최저가</dt><dd>{order.reserveKrw.toLocaleString()}원</dd></>}
          <dt>고객</dt><dd style={styles.mono}>{short(order.customerPubkey)}</dd>
          <dt>후원자</dt><dd style={styles.mono}>{short(order.sponsorPubkey)}</dd>
          {deadline && <><dt>{deadline.label}</dt><dd>{time(deadline.at)}{deadline.penalty ? <span style={styles.note}> · {deadline.penalty}</span> : null}</dd></>}
          {order.escrowAddress && <><dt>에스크로</dt><dd style={styles.mono}>{order.escrowAddress}</dd></>}
          {order.fundingOutpoint && <><dt>펀딩</dt><dd style={styles.mono}>{order.fundingOutpoint} ({order.fundingConfs}컨펌)</dd></>}
          {order.settlementKind && <><dt>종결 사유</dt><dd>{OUTCOME_RULES[order.settlementKind].label}</dd></>}
          {order.settlementTxid && <><dt>종결 tx</dt><dd style={styles.mono}>{order.settlementTxid}</dd></>}
          {order.accountDisputedAt && <><dt>계좌 이의</dt><dd style={styles.warnText}>{time(order.accountDisputedAt)} — 후원자가 계좌를 쓸 수 없다고 했다</dd></>}
          {detail && <>
            <dt>버전</dt><dd>{detail.version}</dd>
            <dt>후원자 받을 주소</dt><dd style={styles.mono}>{detail.payoutAddress ?? '—'} {detail.feerateSatPerVb ? `(${detail.feerateSatPerVb} sat/vB)` : ''}</dd>
            <dt>고객 환불 주소</dt><dd style={styles.mono}>{detail.refundAddress ?? '—'}</dd>
            <dt>사전서명</dt><dd>{detail.hasPresig ? '보관 중' : '—'}</dd>
            {detail.lastSignRequestAt && <><dt>서명 요청</dt><dd>{time(detail.lastSignRequestAt)}</dd></>}
          </>}
        </dl>
      </section>

      {detail ? <Bonds detail={detail} /> : (
        <section style={styles.card}><p style={styles.note}>데몬 상세를 기다리는 중… (명령은 상세가 와야 보낼 수 있습니다)</p></section>
      )}
      {detail && <Actions detail={detail} />}
      {detail && detail.strays.length > 0 && <Rescue detail={detail} />}
      <DisputeChat
        track="onchain" orderId={orderId} messages={messages}
        customer={order.customerPubkey} sponsor={order.sponsorPubkey} accountCommitment={detail?.accountCommitment}
      />
    </div>
  );
}

function Bonds({ detail }: { detail: AdminOcOrderDetail }) {
  if (detail.bonds.length === 0 && detail.candidates === 0) return null;
  const expiresOf = (role: 'customer' | 'sponsor') =>
    role === 'customer' ? detail.customerBondExpiresAt : detail.sponsorBondExpiresAt;
  return (
    <section style={styles.card}>
      <h3 style={styles.h3}>보증금 {detail.candidates > 0 && <span style={styles.note}>· 결제 대기 후원자 {detail.candidates}명</span>}</h3>
      {detail.bonds.map(b => (
        <div key={b.role} style={styles.row}>
          <strong>{b.role === 'customer' ? '고객' : '후원자'}</strong>
          <span>{sats(b.amountSat)}</span>
          <span>{BOND_STATUS[b.status]}</span>
          {/* 몰수는 판정 시점에 집행된다 — 이 시각을 넘긴 판정은 몰수할 게 없을 수 있다 */}
          <span style={styles.note}>HTLC 만료 추정 {time(expiresOf(b.role))}</span>
        </div>
      ))}
    </section>
  );
}

interface ActionSpec {
  cmd: string;
  label: string;
  args?: Record<string, unknown>;
  confirm?: string;
  danger?: boolean;
}

function actionsFor(d: AdminOcOrderDetail): ActionSpec[] {
  const o = d.order;
  const list: ActionSpec[] = [];
  if (o.state === 'disputed' && !o.settlementKind) {
    list.push({
      cmd: 'oc.rule', label: '후원자 승', args: { winner: 'sponsor' },
      confirm: '에스크로가 후원자 받을 주소로 갑니다. 고객 보증금은 지금 몰수됩니다. 되돌릴 수 없습니다.',
    });
    list.push({
      cmd: 'oc.rule', label: '고객 승', args: { winner: 'customer' }, danger: true,
      confirm: '에스크로가 고객 환불 주소로 갑니다. 후원자 보증금은 지금 몰수됩니다. 되돌릴 수 없습니다.',
    });
  }
  if (o.settlementKind === 'refund:account-disputed') {
    list.push({
      cmd: 'oc.account-dispute', label: '계좌 문제 인정 (고객 몰수)', args: { verdict: 'account-bad' },
      confirm: '고객이 쓸 수 없는 계좌를 줬다고 판정합니다. 고객 보증금이 몰수됩니다.',
    });
    list.push({
      cmd: 'oc.account-dispute', label: '인정 안 함 (후원자 몰수)', args: { verdict: 'sponsor-fault' }, danger: true,
      confirm: '이의에 근거가 없다고 판정합니다(입증책임은 후원자). 후원자 보증금이 몰수됩니다.',
    });
  }
  if (o.state === 'presigned' || o.state === 'remitted') {
    list.push({ cmd: 'oc.resend', label: '고객에게 릴리스 서명 요청 다시 보내기' });
  }
  if (o.state === 'refunding' || (o.state === 'disputed' && o.settlementKind)) {
    list.push({ cmd: 'oc.resend', label: '종결 서명 요청 다시 보내기' });
  }
  return list;
}

function useCommand(detail: AdminOcOrderDetail) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (cmd: string, args: Record<string, unknown> = {}, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setStatus('보내는 중…');
    const target = { track: 'onchain', orderId: detail.orderId, version: detail.version };
    void sendCommand(cmd, { ...args, target })
      .then(r => setStatus(resultText(r)))
      .catch(e => setStatus(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return { status, busy, run };
}

function Actions({ detail }: { detail: AdminOcOrderDetail }) {
  const { status, busy, run } = useCommand(detail);
  const actions = actionsFor(detail);
  if (actions.length === 0) return null;
  return (
    <section style={styles.card}>
      <h3 style={styles.h3}>명령 <span style={styles.note}>버전 {detail.version} 기준</span></h3>
      <div style={styles.row}>
        {actions.map(a => (
          <button key={`${a.cmd}:${a.label}`} disabled={busy} style={a.danger ? styles.danger : styles.button}
            onClick={() => run(a.cmd, a.args, a.confirm)}>
            {a.label}
          </button>
        ))}
      </div>
      {status && <p style={styles.note}>{status}</p>}
    </section>
  );
}

/** 약정 밖의 자금 — 고객 환불 주소로 돌려주는 `{A,C}` 서명을 고객에게 요청한다(어드민은 마지막에 서명) */
function Rescue({ detail }: { detail: AdminOcOrderDetail }) {
  const { status, busy, run } = useCommand(detail);
  const done = new Map(detail.rescues.map(r => [`${r.txid}:${r.vout}`, r]));
  return (
    <section style={styles.card}>
      <h3 style={styles.h3}>약정 밖의 자금 <span style={styles.note}>구조 — 고객 환불 주소로</span></h3>
      {detail.strays.map(u => {
        const rescue = done.get(`${u.txid}:${u.vout}`);
        return (
          <div key={`${u.txid}:${u.vout}`} style={styles.row}>
            <span style={styles.mono}>{u.txid.slice(0, 12)}…:{u.vout}</span>
            <span>{sats(u.valueSat)}</span>
            {rescue?.broadcastTxid
              ? <span style={styles.note}>돌려줌 ({rescue.broadcastTxid.slice(0, 12)}…)</span>
              : (
                <button style={styles.button} disabled={busy} onClick={() => run('oc.rescue', { txid: u.txid, vout: u.vout },
                  '이 자금을 고객 환불 주소로 돌려주는 서명을 고객에게 요청합니다.')}>
                  {rescue ? '다시 요청' : '고객에게 돌려주기'}
                </button>
              )}
          </div>
        );
      })}
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
  dl: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: 0, fontSize: 13, color: '#374151', wordBreak: 'break-all' as const },
  note: { fontSize: 12, color: '#6B7280', margin: 0, fontWeight: 400 as const },
  warnText: { color: '#B45309' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  button: { padding: '8px 14px', fontSize: 13, fontWeight: 600 as const, background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  danger: { padding: '8px 14px', fontSize: 13, fontWeight: 600 as const, background: '#DC2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
};
