/**
 * 온체인 오더북 (후원자)
 *
 * ⚠️ **"사줄게"를 눌러도 아무도 예약되지 않는다**(§4.1b). 보증금 인보이스가
 * 발행될 뿐이고, **결제가 먼저 확인된 쪽**이 가져간다. 화면이 그렇게 말해야
 * 한다 — "잡았다"고 읽히면 결제를 미루다 놓친다.
 *
 * "먼저 낸 쪽"이라고 쓰지 않는 이유: 어드민은 30초마다 인보이스 상태를 훑고,
 * 한 틱 안에 둘 다 결제돼 있으면 **발행 순서**로 갈린다. 초 단위 순서를
 * 약속할 수 없으니 약속하지 않는다. 진 쪽은 취소되어 아무것도 잃지 않는다.
 */
import { useState, useSyncExternalStore } from 'react';
import { InvoicePayBlock } from '@sajwo-tracker/shared';
import { getOnchainOrdersSnapshot, listedOrders, subscribeOnchainOrders } from '../store';
import { getDepositInvoicesSnapshot, subscribeDepositInvoices } from '../deposit-store';
import { myOrderXonly } from '../keys';
import { rememberMyClaim } from '../claim-store';
import { publishOnchainClaim } from '../nostr/publish';
import { depositAmountText } from '../deposit-amount';

interface Props {
  myPubkey: string | null;
}

export function OnchainOrderBook({ myPubkey }: Props) {
  useSyncExternalStore(subscribeOnchainOrders, getOnchainOrdersSnapshot);
  const invoices = useSyncExternalStore(subscribeDepositInvoices, getDepositInvoicesSnapshot);
  const orders = myPubkey ? listedOrders(myPubkey) : [];

  if (!myPubkey) return <p style={styles.empty}>키를 준비하는 중…</p>;
  if (orders.length === 0) {
    return <p style={styles.empty}>지금은 올라온 의뢰가 없습니다.</p>;
  }

  return (
    <div style={styles.list}>
      {orders.map(order => {
        const invoice = invoices[order.orderId];
        return (
          <div key={order.orderId} style={styles.card}>
            <div style={styles.row}>
              <strong style={styles.amount}>{order.amountSat.toLocaleString()} sats</strong>
              <span style={styles.network}>{order.network}</span>
            </div>
            {order.reserveKrw !== undefined && (
              <p style={styles.reserve}>최저가 {order.reserveKrw.toLocaleString()}원</p>
            )}

            {invoice && !invoice.done ? (
              <div style={styles.invoiceBox}>
                <p style={styles.invoiceNote}>
                  <strong>보증금 {depositAmountText(invoice.bolt11)}</strong>을 결제하면
                  이 의뢰를 맡게 됩니다. 거래가 정상적으로 끝나면 <strong>그대로 돌려받습니다.</strong>
                </p>
                <p style={styles.invoiceNote}>
                  ⚠️ 같은 의뢰에 다른 분도 보증금을 내고 있을 수 있습니다 —
                  <strong> 결제가 먼저 확인된 쪽이 맡습니다.</strong> 늦은 쪽은 결제가
                  실패 처리되어 아무것도 잃지 않습니다.
                </p>
                <InvoicePayBlock bolt11={invoice.bolt11} />
              </div>
            ) : (
              <ClaimForm orderId={order.orderId} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ClaimForm({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [feerate, setFeerate] = useState('2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button style={styles.claim} onClick={() => setOpen(true)}>사줄게</button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const rate = Number(feerate);
    if (!address.trim()) return setError('받을 주소를 입력하세요.');
    if (!Number.isFinite(rate) || rate <= 0) return setError('수수료율을 숫자로 입력하세요.');

    setBusy(true);
    try {
      const sponsorXonly = await myOrderXonly(orderId);
      // ⚠️ 먼저 기억해 둔다. 발행만 하고 못 적어두면 나중에 **사전서명을 만들 수 없다.**
      rememberMyClaim({ orderId, payoutAddress: address.trim(), feerateSatPerVb: rate });
      const result = await publishOnchainClaim({
        orderId, sponsorXonly, payoutAddress: address.trim(), feerateSatPerVb: rate,
      });
      if (!result.success) setError('발행에 실패했습니다. 다시 시도하세요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.form}>
      <label style={styles.label}>
        비트코인 받을 주소
        <input
          style={styles.input}
          value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder="bc1p… / tb1p…"
        />
      </label>

      <label style={styles.label}>
        수수료율 (sat/vB)
        <input
          style={styles.input}
          inputMode="decimal"
          value={feerate}
          onChange={e => setFeerate(e.target.value.replace(/[^0-9.]/g, ''))}
        />
        <span style={styles.hint}>
          받을 때 쓰는 트랜잭션 수수료입니다. <strong>내가 부담</strong>하므로 내가 정합니다.
          너무 낮으면 확정이 늦어집니다.
        </span>
      </label>

      <div style={styles.warn}>
        결제하면 <strong>6시간 안에</strong> 고객이 펀딩을 컨펌시키고, 그 뒤
        <strong> 15분 안에 앱이 서명</strong>합니다. 앱을 열어둘 수 있을 때 결제하세요.
      </div>

      {error && <p style={styles.error}>{error}</p>}
      <button type="submit" style={styles.claim} disabled={busy}>
        {busy ? '보내는 중…' : '보증금 인보이스 받기'}
      </button>
    </form>
  );
}

const styles = {
  list: { display: 'flex', flexDirection: 'column' as const, gap: 12 },
  empty: { fontSize: 14, color: '#6B7280', textAlign: 'center' as const, padding: '32px 0' },
  card: { border: '1px solid #E5E7EB', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column' as const, gap: 10 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  amount: { fontSize: 18, color: '#111827' },
  network: { fontSize: 11, color: '#6B7280', background: '#F3F4F6', padding: '2px 8px', borderRadius: 4 },
  reserve: { margin: 0, fontSize: 12, color: '#6B7280' },
  claim: { padding: '10px 16px', fontSize: 14, fontWeight: 600 as const, background: '#059669', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  form: { display: 'flex', flexDirection: 'column' as const, gap: 12 },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 6, fontSize: 13, fontWeight: 600 as const, color: '#374151' },
  input: { padding: '10px 12px', fontSize: 14, border: '1px solid #D1D5DB', borderRadius: 8 },
  hint: { fontSize: 11, fontWeight: 400 as const, color: '#6B7280', lineHeight: 1.5 },
  warn: { background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#9A3412', lineHeight: 1.6 },
  invoiceBox: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  invoiceNote: { margin: 0, fontSize: 12, color: '#9A3412', background: '#FFF7ED', padding: '8px 10px', borderRadius: 6, lineHeight: 1.5 },
  error: { margin: 0, fontSize: 13, color: '#DC2626' },
};
