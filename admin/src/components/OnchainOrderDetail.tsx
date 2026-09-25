/**
 * 온체인 오더 상세 · 판정 · 구조
 *
 * 사람이 판단하는 건 셋뿐이다 — **분쟁 판정, 계좌 이의 판정, 구조.** 나머지(가격 고정·마감·환불 결정·
 * 브로드캐스트·재촉)는 데몬 워처가 한다. 버튼은 전부 데몬 상세의 **버전**을 싣는다 — 다른 기기에서 이미
 * 판정했으면 데몬이 거절한다(DM-006).
 *
 * 여기에는 어드민 키가 없다. 서명은 데몬이 시드에서 파생한 키로 **마지막에** 한다.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { dateTimeText, type AdminOcOrderDetail } from '@sajwo-tracker/shared';
import {
  OUTCOME_RULES, currentOnchainDeadline, explorerAddressUrl, explorerTxUrl, onchainStateDisplay,
  type BtcNetworkName, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { sendCommand } from '../daemon/client';
import { chats, ocDetails, onchainOrders } from '../daemon/stores';
import { WAITING_DETAIL_TEXT, commandResultText, satsText, shortNpub } from '../format';
import { DisputeChat } from './DisputeChat';
import { ui } from '../ui';

const BOND_STATUS: Record<AdminOcOrderDetail['bonds'][number]['status'], string> = {
  creating: '만드는 중',
  open: '결제 대기',
  accepted: '잡힘',
  settled: '몰수',
  cancelled: '환불·만료',
};

export function OnchainOrderDetail({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const publicOrder = useSyncExternalStore(onchainOrders.subscribe, onchainOrders.get)[orderId];
  const view = useSyncExternalStore(ocDetails.subscribe, ocDetails.get)[orderId];
  const messages = useSyncExternalStore(chats.subscribe, chats.get)[`onchain:${orderId}`] ?? [];
  const detail = view?.detail;
  const order: Omit<OnchainOrder, 'raw'> | undefined = detail?.order ?? publicOrder;

  useEffect(() => {
    if (!detail) void sendCommand('oc.detail', { orderId });
  }, [orderId, detail]);

  // 주소로 바로 열면(새로고침·링크) 오더가 캐시에 오기 전일 수 있다 — 그 사이에도 돌아갈 길은 있어야 한다
  if (!order) {
    return (
      <div style={ui.column}>
        <button style={ui.back} onClick={onBack}>← 목록</button>
        <p style={ui.note}>오더를 불러오는 중… (데몬 epoch 전의 오더거나 id가 틀렸으면 오지 않습니다)</p>
      </div>
    );
  }
  const display = onchainStateDisplay(order.state);
  const deadline = currentOnchainDeadline(order);

  return (
    <div style={ui.column}>
      <button style={ui.back} onClick={onBack}>← 목록</button>
      <section style={ui.card}>
        <div style={ui.row}>
          <h2 style={ui.h2}><span style={styles.mono}>{orderId}</span></h2>
          <span style={{ ...ui.badge, color: display.color, background: display.bg }}>{display.label}</span>
          <span style={ui.note}>{order.network}</span>
        </div>
        <dl style={ui.dl}>
          <dt>금액</dt><dd>{satsText(order.amountSat)}{order.priceKrw ? ` · 고정가 ${order.priceKrw.toLocaleString()}원` : ''}</dd>
          {order.reserveKrw && <><dt>최저가</dt><dd>{order.reserveKrw.toLocaleString()}원</dd></>}
          <dt>고객</dt><dd style={styles.mono}>{shortNpub(order.customerPubkey)}</dd>
          <dt>후원자</dt><dd style={styles.mono}>{shortNpub(order.sponsorPubkey)}</dd>
          {deadline && <><dt>{deadline.label}</dt><dd>{dateTimeText(deadline.at)}{deadline.penalty ? <span style={ui.note}> · {deadline.penalty}</span> : null}</dd></>}
          {order.escrowAddress && <><dt>에스크로</dt><dd style={styles.mono}><Explore href={explorerAddressUrl(order.network, order.escrowAddress)} text={order.escrowAddress} /></dd></>}
          {order.fundingOutpoint && <><dt>펀딩</dt><dd style={styles.mono}><Explore href={explorerTxUrl(order.network, order.fundingOutpoint)} text={order.fundingOutpoint} /> ({order.fundingConfs}컨펌)</dd></>}
          {order.settlementKind && <><dt>종결 사유</dt><dd>{OUTCOME_RULES[order.settlementKind].label}</dd></>}
          {order.settlementTxid && <><dt>종결 tx</dt><dd style={styles.mono}><Explore href={explorerTxUrl(order.network, order.settlementTxid)} text={order.settlementTxid} /></dd></>}
          {order.accountDisputedAt && <><dt>계좌 이의</dt><dd style={ui.warnText}>{dateTimeText(order.accountDisputedAt)} — 후원자가 계좌를 쓸 수 없다고 했다</dd></>}
          {detail && <>
            <dt>버전</dt><dd>{detail.version}</dd>
            <dt>후원자 받을 주소</dt><dd style={styles.mono}><AddressLink network={order.network} address={detail.payoutAddress} /> {detail.feerateSatPerVb ? `(${detail.feerateSatPerVb} sat/vB)` : ''}</dd>
            <dt>고객 환불 주소</dt><dd style={styles.mono}><AddressLink network={order.network} address={detail.refundAddress} /></dd>
            <dt>사전서명</dt><dd>{detail.hasPresig ? '보관 중' : '—'}</dd>
            {detail.lastSignRequestAt && <><dt>서명 요청</dt><dd>{dateTimeText(detail.lastSignRequestAt)}</dd></>}
          </>}
        </dl>
      </section>

      {detail ? <Bonds detail={detail} /> : (
        <section style={ui.card}><p style={ui.note}>{WAITING_DETAIL_TEXT}</p></section>
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

/** mempool.space로 — 네트워크가 안 맞거나 regtest면 글자만 (`explorer.ts`) */
function Explore({ href, text }: { href: string | null; text: string }) {
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" style={styles.link}>{text}</a> : <>{text}</>;
}

function AddressLink({ network, address }: { network: BtcNetworkName; address: string | undefined }) {
  return address ? <Explore href={explorerAddressUrl(network, address)} text={address} /> : <>—</>;
}

function Bonds({ detail }: { detail: AdminOcOrderDetail }) {
  if (detail.bonds.length === 0 && detail.candidates === 0) return null;
  const expiresOf = (role: 'customer' | 'sponsor') =>
    role === 'customer' ? detail.customerBondExpiresAt : detail.sponsorBondExpiresAt;
  return (
    <section style={ui.card}>
      <h3 style={ui.h3}>보증금 {detail.candidates > 0 && <span style={ui.note}>· 결제 대기 후원자 {detail.candidates}명</span>}</h3>
      {detail.bonds.map(b => (
        <div key={b.role} style={ui.row}>
          <strong>{b.role === 'customer' ? '고객' : '후원자'}</strong>
          <span>{satsText(b.amountSat)}</span>
          <span>{BOND_STATUS[b.status]}</span>
          {/* 몰수는 판정 시점에 집행된다 — 이 시각을 넘긴 판정은 몰수할 게 없을 수 있다 */}
          <span style={ui.note}>HTLC 만료 추정 {dateTimeText(expiresOf(b.role))}</span>
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
      .then(r => setStatus(commandResultText(r)))
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
    <section style={ui.card}>
      <h3 style={ui.h3}>명령 <span style={ui.note}>버전 {detail.version} 기준</span></h3>
      <div style={ui.row}>
        {actions.map(a => (
          <button key={`${a.cmd}:${a.label}`} disabled={busy} style={a.danger ? ui.danger : ui.button}
            onClick={() => run(a.cmd, a.args, a.confirm)}>
            {a.label}
          </button>
        ))}
      </div>
      {status && <p style={ui.note}>{status}</p>}
    </section>
  );
}

/** 약정 밖의 자금 — 고객 환불 주소로 돌려주는 `{A,C}` 서명을 고객에게 요청한다(어드민은 마지막에 서명) */
function Rescue({ detail }: { detail: AdminOcOrderDetail }) {
  const { status, busy, run } = useCommand(detail);
  const done = new Map(detail.rescues.map(r => [`${r.txid}:${r.vout}`, r]));
  return (
    <section style={ui.card}>
      <h3 style={ui.h3}>약정 밖의 자금 <span style={ui.note}>구조 — 고객 환불 주소로</span></h3>
      {detail.strays.map(u => {
        const rescue = done.get(`${u.txid}:${u.vout}`);
        return (
          <div key={`${u.txid}:${u.vout}`} style={ui.row}>
            <span style={styles.mono}><Explore href={explorerTxUrl(detail.order.network, u.txid)} text={`${u.txid.slice(0, 12)}…:${u.vout}`} /></span>
            <span>{satsText(u.valueSat)}</span>
            {rescue?.broadcastTxid
              ? <span style={ui.note}>돌려줌 (<Explore href={explorerTxUrl(detail.order.network, rescue.broadcastTxid)} text={`${rescue.broadcastTxid.slice(0, 12)}…`} />)</span>
              : (
                <button style={ui.button} disabled={busy} onClick={() => run('oc.rescue', { txid: u.txid, vout: u.vout },
                  '이 자금을 고객 환불 주소로 돌려주는 서명을 고객에게 요청합니다.')}>
                  {rescue ? '다시 요청' : '고객에게 돌려주기'}
                </button>
              )}
          </div>
        );
      })}
      {status && <p style={ui.note}>{status}</p>}
    </section>
  );
}

const styles = {
  mono: { fontFamily: 'monospace', fontSize: 12, overflowWrap: 'anywhere' as const },
  link: { color: '#2563EB' },
};
