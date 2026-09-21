/**
 * 내 온체인 거래 — 역할별 액션 (PLAN-ONCHAIN-TRACK §9 · O-007 · T-106)
 *
 * 역할은 **pubkey 비교로 유도**한다. 칼럼을 따로 두지 않는다(라이트닝과 같은 규칙).
 *
 * ⚠️ 이 화면의 핵심 규칙 둘:
 *   ① **릴리스는 자동이 아니다**(O-007). 고객이 은행 입금을 눈으로 확인하고 누른다
 *   ② **원화 송금 전에 타임락을 확인시킨다**(T-106). 모르면 막는다
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { InvoicePayBlock } from '@sajwo-tracker/shared';
import {
  MempoolChainAdapter, onchainStateDisplay, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { getOnchainOrdersSnapshot, myOnchainOrders, roleIn, subscribeOnchainOrders } from '../store';
import { getDepositInvoicesSnapshot, subscribeDepositInvoices } from '../deposit-store';
import {
  clearSignRequest, getSignRequestsSnapshot, subscribeSignRequests, type SignRequest,
} from '../sign-request-store';
import {
  forgetPendingRequest, getPendingRequestsSnapshot, subscribePendingRequests,
} from '../pending-request-store';
import { getOnchainAccountsSnapshot, subscribeOnchainAccounts } from '../account-store';
import { depositAmountText } from '../deposit-amount';
import { cosignSettlement, timelockStatus } from '../actions';
import { inspectSettlementPsbt, releaseNeedsPriceOverride } from '../verify';
import {
  publishOnchainAccountInfo, publishOnchainCosign, publishOnchainDispute,
} from '../nostr/publish';
import { publishRemitRequestOnchain } from '../nostr/remit';
import { EscrowAddressPanel } from './EscrowAddressPanel';
import { OnchainProgressBar } from './OnchainProgressBar';

interface Props {
  myPubkey: string | null;
}

export function OnchainMyOrders({ myPubkey }: Props) {
  useSyncExternalStore(subscribeOnchainOrders, getOnchainOrdersSnapshot);
  const invoices = useSyncExternalStore(subscribeDepositInvoices, getDepositInvoicesSnapshot);
  const signRequests = useSyncExternalStore(subscribeSignRequests, getSignRequestsSnapshot);
  const pendingRequests = useSyncExternalStore(
    subscribePendingRequests, getPendingRequestsSnapshot,
  );

  if (!myPubkey) return <p style={styles.empty}>키를 준비하는 중…</p>;
  const orders = myOnchainOrders(myPubkey);

  /**
   * ⚠️ **오더가 아직 없는 보증금 인보이스**가 따로 있다.
   *
   * 의뢰 등록은 §4.1b대로 **보증금 결제가 곧 등록**이라, 결제 전에는 오더 자체가
   * 존재하지 않는다. 그래서 이걸 오더 카드 안에서만 그리면 **결제할 화면이
   * 영영 안 나오고 흐름이 멈춘다**(2026-09-21 실제로 그랬다).
   */
  const orphanInvoices = Object.values(invoices).filter(
    inv => inv.bolt11 && !inv.done && !orders.some(o => o.orderId === inv.orderId),
  );

  const waiting = Object.values(pendingRequests);

  if (orders.length === 0 && orphanInvoices.length === 0 && waiting.length === 0) {
    return <p style={styles.empty}>아직 온체인 거래가 없습니다.</p>;
  }

  return (
    <div style={styles.list}>
      {waiting.map(req => (
        <div key={req.orderId} style={styles.card}>
          <div style={styles.head}>
            <span style={{
              ...styles.badge,
              ...(req.rejectedReason
                ? { color: '#991B1B', background: '#FEE2E2' }
                : { color: '#6B7280', background: '#F3F4F6' }),
            }}>
              {req.rejectedReason ? '등록 거절됨' : '등록 요청 보냄'}
            </span>
            <span style={styles.meta}>{req.amountSat.toLocaleString()} sats</span>
          </div>
          {req.rejectedReason ? (
            <p style={styles.dangerText}>{req.rejectedReason}</p>
          ) : (
            <p style={styles.warnText}>
              운영자가 보증금 인보이스를 보내기를 기다리는 중입니다.
              몇 분이 지나도 안 오면 운영자에게 문의하세요.
            </p>
          )}
          <button style={styles.ghost} onClick={() => forgetPendingRequest(req.orderId)}>
            이 기록 지우기
          </button>
        </div>
      ))}

      {orphanInvoices.map(inv => (
        <div key={inv.orderId} style={styles.card}>
          <div style={styles.head}>
            <span style={{ ...styles.badge, color: '#D97706', background: '#FEF3C7' }}>
              보증금 결제 대기
            </span>
            <span style={styles.meta}>{inv.orderId}</span>
          </div>
          <p style={styles.warnText}>
            <strong>보증금 {depositAmountText(inv.bolt11)}을 결제해야</strong> 의뢰가
            오더북에 올라갑니다. 거래가 정상적으로 끝나면 그대로 돌려받습니다.
          </p>
          <InvoicePayBlock bolt11={inv.bolt11} />
        </div>
      ))}

      {orders.map(order => (
        <OrderCard
          key={order.orderId}
          order={order}
          role={roleIn(order, myPubkey)!}
          invoiceBolt11={invoices[order.orderId]?.done ? undefined : invoices[order.orderId]?.bolt11}
          signRequest={signRequests[order.orderId]}
        />
      ))}
    </div>
  );
}

function OrderCard({ order, role, invoiceBolt11, signRequest }: {
  order: OnchainOrder;
  role: 'customer' | 'sponsor';
  invoiceBolt11?: string;
  signRequest?: SignRequest;
}) {
  const badge = onchainStateDisplay(order.state);

  return (
    <div style={styles.card}>
      <div style={styles.head}>
        <span style={{ ...styles.badge, color: badge.color, background: badge.bg }}>
          {badge.label}
        </span>
        <span style={styles.role}>{role === 'customer' ? '판매' : '구매'}</span>
        <strong style={styles.amount}>{order.amountSat.toLocaleString()} sats</strong>
      </div>

      {order.priceKrw !== undefined && (
        <p style={styles.price}>
          확정 금액 <strong>{order.priceKrw.toLocaleString()}원</strong>
          {role === 'sponsor' && order.payoutSat !== undefined && (
            <span style={styles.sub}> · 받을 {order.payoutSat.toLocaleString()} sats</span>
          )}
        </p>
      )}

      <OnchainProgressBar order={order} role={role} accountInfoSent={Boolean(order.accountSentAt)} />

      {invoiceBolt11 && (
        <div style={styles.section}>
          <p style={styles.sectionTitle}>보증금 결제</p>
          <InvoicePayBlock bolt11={invoiceBolt11} />
        </div>
      )}

      {role === 'customer' && order.state === 'bonded' && (
        <EscrowAddressPanel order={order} role="customer" />
      )}

      {role === 'customer' && order.state === 'presigned' && !order.accountSentAt && (
        <AccountInfoForm order={order} />
      )}

      {/*
        ⚠️ **한 번 보내고 끝이면 안 된다.** 후원자가 그때 접속 중이 아니었거나
        이벤트를 놓치면, 후원자는 어디로 보낼지 모른 채 마감 시계만 흐른다.
        내용은 그대로 다시 보낸다 — 계좌를 **바꾸면** 후원자가 이미 본 것과
        달라지므로, 여기서는 재입력을 받지 않는다.
      */}
      {role === 'customer' && order.accountSentAt
        && (order.state === 'presigned' || order.state === 'remitted') && (
        <ResendAccountInfo order={order} />
      )}

      {role === 'sponsor' && order.state === 'presigned' && (
        <RemitPanel order={order} />
      )}

      {signRequest && <SignPanel order={order} request={signRequest} />}

      {(order.state === 'remitted' || order.state === 'presigned') && (
        <DisputeButton order={order} role={role} />
      )}
    </div>
  );
}

/** 고객: 계좌 공개 — 여기서부터 후원자의 30분이 시작된다 (O-013) */
function AccountInfoForm({ order }: { order: OnchainOrder }) {
  const [bank, setBank] = useState('');
  const [number, setNumber] = useState('');
  const [holder, setHolder] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!order.sponsorPubkey || !bank || !number || !holder) return;
    setBusy(true);
    try {
      // ⚠️ 필드명은 `AccountInfo`와 **정확히** 같아야 한다 — 다르면 후원자 쪽에서
      // 파싱이 실패해 계좌가 통째로 안 뜬다(2026-09-21에 `accountHolder`로 보내 그랬다).
      await publishOnchainAccountInfo(order.orderId, order.sponsorPubkey, {
        bankName: bank, accountNumber: number, holderName: holder,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>입금받을 계좌 (5분 안에)</p>
      <p style={styles.warnText}>
        늦으면 거래가 취소되고 <strong>보증금을 잃습니다.</strong> 계좌는 후원자에게만
        암호화되어 전달됩니다.
      </p>
      <input style={styles.input} placeholder="은행" value={bank} onChange={e => setBank(e.target.value)} />
      <input style={styles.input} placeholder="계좌번호" value={number} onChange={e => setNumber(e.target.value)} />
      <input style={styles.input} placeholder="예금주" value={holder} onChange={e => setHolder(e.target.value)} />
      <button style={styles.primary} onClick={() => void send()} disabled={busy}>
        {busy ? '보내는 중…' : '계좌 정보 전달'}
      </button>
    </div>
  );
}

/** 고객: 계좌를 다시 보낸다 (내용은 그대로) */
function ResendAccountInfo({ order }: { order: OnchainOrder }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [bank, setBank] = useState('');
  const [number, setNumber] = useState('');
  const [holder, setHolder] = useState('');
  const [open, setOpen] = useState(false);

  async function send() {
    if (!order.sponsorPubkey || !bank || !number || !holder) return;
    setBusy(true);
    try {
      await publishOnchainAccountInfo(order.orderId, order.sponsorPubkey, {
        bankName: bank, accountNumber: number, holderName: holder,
      });
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div style={styles.section}>
        <p style={styles.sectionTitle}>후원자가 계좌를 못 받았나요?</p>
        <button style={styles.ghost} onClick={() => setOpen(true)}>계좌 다시 보내기</button>
      </div>
    );
  }

  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>계좌 다시 보내기</p>
      <p style={styles.warnText}>
        <strong>처음에 보낸 것과 같은 계좌를 넣으세요.</strong> 다른 계좌를 보내면
        후원자가 이미 본 것과 달라져 입금이 엉킵니다.
      </p>
      <input style={styles.input} placeholder="은행" value={bank} onChange={e => setBank(e.target.value)} />
      <input style={styles.input} placeholder="계좌번호" value={number} onChange={e => setNumber(e.target.value)} />
      <input style={styles.input} placeholder="예금주" value={holder} onChange={e => setHolder(e.target.value)} />
      <button style={styles.primary} onClick={() => void send()} disabled={busy || done}>
        {done ? '다시 보냈습니다' : busy ? '보내는 중…' : '다시 보내기'}
      </button>
    </div>
  );
}


/**
 * 후원자: 원화 송금.
 *
 * ⚠️ **타임락 잔여를 확인하기 전에는 버튼을 열지 않는다**(T-106 · §7.1).
 * 라이트닝에서 정확히 같은 모양의 버그를 겪었다 — 보호 창이 곧 닫히는데
 * 송금을 받아줘서 후원자만 잃었다(AUDIT-EXPIRY F2).
 */
function RemitPanel({ order }: { order: OnchainOrder }) {
  const [confs, setConfs] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const accounts = useSyncExternalStore(subscribeOnchainAccounts, getOnchainAccountsSnapshot);
  const account = accounts[order.orderId];

  useEffect(() => {
    let alive = true;
    const txid = order.fundingOutpoint?.split(':')[0];
    if (!txid) return;
    const chain = new MempoolChainAdapter({
      network: order.network === 'mainnet' ? 'mainnet' : 'signet',
    });
    void chain.getTxStatus(txid).then(result => {
      if (alive && result.known) setConfs(result.value.confirmations);
    });
    return () => { alive = false; };
  }, [order.fundingOutpoint, order.network]);

  const status = timelockStatus(order, confs);

  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>원화 송금</p>

      {account ? (
        <div style={styles.account}>
          <p style={styles.accountLine}>
            <strong>{account.bankName}</strong> {account.accountNumber}
          </p>
          <p style={styles.accountLine}>예금주 {account.holderName}</p>
          {order.priceKrw !== undefined && (
            <p style={styles.accountAmount}>
              보낼 금액 <strong>{order.priceKrw.toLocaleString()}원</strong>
            </p>
          )}
        </div>
      ) : (
        <p style={styles.warnText}>고객이 계좌를 보내기를 기다리는 중입니다.</p>
      )}

      <p style={status.safeToRemit ? styles.okText : styles.warnText}>{status.reason}</p>
      <p style={styles.warnText}>
        <strong>즉시 이체만 사용하세요.</strong> 지연 이체는 시간 안에 도착하지 않아
        보증금을 잃습니다.
      </p>
      <button
        style={status.safeToRemit && account ? styles.primary : styles.disabled}
        disabled={!status.safeToRemit || !account || busy || sent}
        onClick={() => {
          setBusy(true);
          void publishRemitRequestOnchain(order.orderId)
            .then(() => setSent(true))
            .finally(() => setBusy(false));
        }}
      >
        {sent ? '송금 완료를 알렸습니다' : busy ? '보내는 중…' : '원화 송금했어요'}
      </button>
    </div>
  );
}

/** 서명 요청 — 릴리스·환불·분쟁 공용. **내용을 보여주고 유저가 누른다** */
function SignPanel({ order, request }: { order: OnchainOrder; request: SignRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = inspectSettlementPsbt(order, request.psbt);
  const stale = request.purpose === 'release' && releaseNeedsPriceOverride(order, Date.now());
  const [override, setOverride] = useState(false);

  const title = request.purpose === 'release' ? '릴리스 서명 (비트코인 지급)'
    : request.purpose === 'refund' ? '환불 서명 (에스크로 회수)'
    : '분쟁 판정 집행 서명';

  async function sign() {
    setBusy(true);
    setError(null);
    try {
      const signed = await cosignSettlement(order.orderId, request.psbt);
      if (!signed.ok) return setError(signed.reason);
      const result = await publishOnchainCosign(order.orderId, request.purpose, signed.psbt);
      if (!result.success) return setError('발행에 실패했습니다. 다시 시도하세요.');
      clearSignRequest(order.orderId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>{title}</p>

      {!check.ok ? (
        <p style={styles.dangerText}>⚠️ {check.reason} — 서명하지 마세요.</p>
      ) : (
        <>
          <p style={styles.okText}>
            이 트랜잭션은 <strong>{check.amountSat.toLocaleString()} sats</strong>를 옮깁니다.
            내 에스크로를 쓰는 것이 맞습니다.
          </p>

          {request.purpose === 'release' && (
            <p style={styles.warnText}>
              <strong>은행에 원화가 실제로 들어왔는지 먼저 확인하세요.</strong>
              서명하는 순간 비트코인이 후원자에게 넘어갑니다.
            </p>
          )}

          {stale && (
            <div style={styles.danger}>
              <strong>가격 유효창이 지났습니다.</strong>
              <p style={styles.dangerText}>
                이 금액은 24시간 넘게 전의 시세입니다. 지금 시세와 다를 수 있습니다.
              </p>
              <label style={styles.checkbox}>
                <input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} />
                알고도 진행합니다
              </label>
            </div>
          )}

          {error && <p style={styles.dangerText}>{error}</p>}

          <button
            style={stale && !override ? styles.disabled : styles.primary}
            disabled={busy || (stale && !override)}
            onClick={() => void sign()}
          >
            {busy ? '서명 중…' : '서명하고 보내기'}
          </button>
        </>
      )}
    </div>
  );
}

function DisputeButton({ order, role }: { order: OnchainOrder; role: 'customer' | 'sponsor' }) {
  const [busy, setBusy] = useState(false);
  const isAccountIssue = order.state === 'presigned' && role === 'sponsor';

  return (
    <div style={styles.section}>
      {isAccountIssue && (
        <p style={styles.warnText}>
          계좌를 쓸 수 없다면 알려주세요. <strong>다만 송금 마감 시계는 멈추지 않습니다</strong> —
          정당한 사유면 보증금은 돌려받습니다.
        </p>
      )}
      <button
        style={styles.ghost}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void publishOnchainDispute(order.orderId, isAccountIssue ? 'account-unusable' : 'remitted')
            .finally(() => setBusy(false));
        }}
      >
        {isAccountIssue ? '계좌를 쓸 수 없습니다' : '문제가 있습니다 (분쟁)'}
      </button>
    </div>
  );
}

const styles = {
  list: { display: 'flex', flexDirection: 'column' as const, gap: 14 },
  empty: { fontSize: 14, color: '#6B7280', textAlign: 'center' as const, padding: '32px 0' },
  card: { border: '1px solid #E5E7EB', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column' as const, gap: 12 },
  head: { display: 'flex', alignItems: 'center', gap: 8 },
  badge: { fontSize: 12, fontWeight: 600 as const, padding: '3px 8px', borderRadius: 6 },
  role: { fontSize: 11, color: '#6B7280', background: '#F3F4F6', padding: '2px 6px', borderRadius: 4 },
  amount: { marginLeft: 'auto', fontSize: 16, color: '#111827' },
  price: { margin: 0, fontSize: 14, color: '#374151' },
  sub: { color: '#6B7280', fontSize: 13 },
  meta: { fontSize: 12, color: '#6B7280' },
  section: { display: 'flex', flexDirection: 'column' as const, gap: 8, borderTop: '1px solid #F3F4F6', paddingTop: 12 },
  sectionTitle: { margin: 0, fontSize: 13, fontWeight: 600 as const, color: '#374151' },
  input: { padding: '9px 11px', fontSize: 14, border: '1px solid #D1D5DB', borderRadius: 8 },
  primary: { padding: '11px', fontSize: 14, fontWeight: 600 as const, background: '#2563EB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  disabled: { padding: '11px', fontSize: 14, fontWeight: 600 as const, background: '#E5E7EB', color: '#9CA3AF', border: 'none', borderRadius: 8, cursor: 'not-allowed' },
  ghost: { padding: '9px', fontSize: 13, background: '#fff', color: '#6B7280', border: '1px solid #D1D5DB', borderRadius: 8, cursor: 'pointer' },
  okText: { margin: 0, fontSize: 13, color: '#065F46', lineHeight: 1.6 },
  warnText: { margin: 0, fontSize: 12, color: '#9A3412', lineHeight: 1.6 },
  dangerText: { margin: 0, fontSize: 13, color: '#991B1B', lineHeight: 1.6 },
  danger: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column' as const, gap: 6, color: '#991B1B' },
  checkbox: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 },
  account: { background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '10px 12px' },
  accountLine: { margin: 0, fontSize: 14, color: '#111827', lineHeight: 1.7 },
  accountAmount: { margin: '6px 0 0', fontSize: 14, color: '#2563EB' },
};
