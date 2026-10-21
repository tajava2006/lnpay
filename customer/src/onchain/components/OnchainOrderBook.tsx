/**
 * 온체인 오더북 (후원자)
 *
 * ⚠️ **"사줄게"를 눌러도 아무도 예약되지 않는다**. 보증금 인보이스가
 * 발행될 뿐이고, **결제가 먼저 확인된 쪽**이 가져간다. 화면이 그렇게 말해야
 * 한다 — "잡았다"고 읽히면 결제를 미루다 놓친다.
 *
 * "먼저 낸 쪽"이라고 쓰지 않는 이유: 어드민은 30초마다 인보이스 상태를 훑고,
 * 한 틱 안에 둘 다 결제돼 있으면 **발행 순서**로 갈린다. 초 단위 순서를
 * 약속할 수 없으니 약속하지 않는다. 진 쪽은 취소되어 아무것도 잃지 않는다.
 *
 * **지정 거래**(docs/ONCHAIN-TRACK.md §10)는 오더북이 아니라 맨 위 "나를 지정한 거래"에 뜬다. 같은 카드·같은
 * 클레임 폼을 쓰되 보증금이 없다 — 합의한 조건을 확인하고 위험 고지를 체크한 뒤 수락하면 바로 내가 맡는다.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  DESIGNATED_COPY, HOLD_DEPOSIT_NOTE, InvoicePayBlock, freshPrice, guarded, type PriceTracker,
} from '@sajwo-tracker/shared';
import {
  FUNDING_WINDOW_SEC, MempoolChainAdapter, PRESIGN_WINDOW_SEC, RESERVE_MIN_GAP_PERCENT, TYPICAL_SETTLEMENT_VSIZE,
  addressProblem, durationText, releaseFeerateProblem, type FeeEstimates, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { designatedToMe, getOnchainOrdersSnapshot, listedOrders, subscribeOnchainOrders } from '../store';
import {
  DesignatedAcceptConsent, DesignatedHeader,
} from '../../designated/components';
import { getDepositInvoicesSnapshot, subscribeDepositInvoices, type DepositInvoice } from '../deposit-store';
import { myOrderXonly } from '../keys';
import { forgetMyClaim, getMyClaim, pendingClaim, rememberMyClaim, type MyClaim } from '../claim-store';
import { clearNotice, getNoticesSnapshot, subscribeNotices } from '../notice-store';
import { publishOnchainClaim } from '../nostr/publish';
import { depositAmountText } from '../deposit-amount';
import { ui } from '../../ui';

interface Props {
  myPubkey: string | null;
  tracker?: PriceTracker;
}

const NO_SUBSCRIBE = () => () => {};
const NO_SNAPSHOT = () => null;

/** 오더북이 쓰는 시세 — 1분 넘게 낡았으면 없는 것으로 본다 */
export function useBookPrice(tracker: PriceTracker | undefined): number | null {
  const snapshot = useSyncExternalStore(
    tracker?.subscribe ?? NO_SUBSCRIBE,
    tracker?.getSnapshot ?? NO_SNAPSHOT,
  );
  return snapshot ? freshPrice(snapshot, Date.now(), 60_000, 1) : null;
}

export function OnchainOrderBook({ myPubkey, tracker }: Props) {
  useSyncExternalStore(subscribeOnchainOrders, getOnchainOrdersSnapshot);
  const price = useBookPrice(tracker);
  const invoices = useSyncExternalStore(subscribeDepositInvoices, getDepositInvoicesSnapshot);
  const orders = myPubkey ? listedOrders(myPubkey) : [];
  const offers = myPubkey ? designatedToMe(myPubkey) : [];

  if (!myPubkey) return <p style={ui.empty}>키를 준비하는 중…</p>;

  return (
    <div>
      <DesignatedHeader track="onchain" />
      {offers.length > 0 && (
        <>
          <h2 className="section-title">나를 지정한 거래</h2>
          <div style={{ ...styles.list, marginBottom: 24 }}>
            {offers.map(order => (
              <OnchainBookCard key={order.orderId} order={order} invoice={invoices[order.orderId]} price={price} />
            ))}
          </div>
        </>
      )}
      {orders.length === 0 ? (
        <p style={ui.empty}>지금은 올라온 의뢰가 없습니다.</p>
      ) : (
        <div style={styles.list}>
          {orders.map(order => (
            <OnchainBookCard key={order.orderId} order={order} invoice={invoices[order.orderId]} price={price} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 남의 의뢰 하나 — 오더북 목록과 상세(다른 오더 모음의 링크로 들어온 사람)가 같이 쓴다
 */
export const OnchainBookCard = guarded(OnchainBookCardBody, '오더북 카드');

function OnchainBookCardBody({ order, invoice, price }: {
  order: OnchainOrder; invoice: DepositInvoice | undefined; price: number | null;
}) {
  return (
    <div style={order.designatedSponsor ? { ...styles.card, ...styles.cardDesignated } : styles.card}>
      <div style={styles.row}>
        <strong style={styles.amount}>{order.amountSat.toLocaleString()} sats</strong>
        <span style={styles.network}>{order.designatedSponsor ? '지정 거래 · ' : ''}{order.network}</span>
      </div>
      {order.designatedSponsor && (
        <p style={styles.hint}>
          고객이 나를 상대로 지정한 의뢰입니다. 수락하면 보증금 없이 바로 내가 맡습니다.
        </p>
      )}
      {order.reserveKrw !== undefined && <ReserveLine order={order} price={price} />}

      {invoice && !invoice.done ? (
        <div style={styles.invoiceBox}>
          <p style={styles.invoiceNote}>
            <strong>보증금 {depositAmountText(invoice.bolt11)}</strong>을 결제하면
            이 의뢰를 맡게 됩니다.
          </p>
          <p style={styles.invoiceNote}>{HOLD_DEPOSIT_NOTE.full}</p>
          <p style={styles.invoiceNote}>
            ⚠️ 같은 의뢰에 다른 분도 보증금을 내고 있을 수 있습니다 —
            <strong> 결제가 먼저 확인된 쪽이 맡습니다.</strong> 늦은 쪽은 결제가
            실패 처리되어 아무것도 잃지 않습니다.
          </p>
          <InvoicePayBlock bolt11={invoice.bolt11} />
        </div>
      ) : (
        <ClaimForm order={order} invoice={invoice} />
      )}
    </div>
  );
}

/**
 * 최저가가 지금 시세에서 얼마나 떨어져 있는지.
 *
 * 최저가가 시세에 붙어 있으면 **컨펌을 기다리는 사이 시세가 조금만 내려도 무과실
 * 환불**된다 — 후원자는 보증금과 시간을 묶인 채 아무것도 못 얻는다. 어드민이 등록 때
 * 3% 간격을 요구하지만, 며칠 떠 있는 사이 시세가 최저가 쪽으로 다가올 수 있다.
 * 그걸 후원자가 **보고** 고르게 한다.
 */
function ReserveLine({ order, price }: { order: OnchainOrder; price: number | null }) {
  const reserve = order.reserveKrw!;
  if (!price) return <p style={styles.reserve}>최저가 {reserve.toLocaleString()}원</p>;
  const spot = (order.amountSat / 1e8) * price;
  const gapPct = ((spot - reserve) / spot) * 100;
  const close = gapPct < RESERVE_MIN_GAP_PERCENT;
  return (
    <p style={close ? styles.reserveClose : styles.reserve}>
      최저가 {reserve.toLocaleString()}원 · 지금 시세보다 {gapPct.toFixed(1)}% 아래
      {close && ' — 시세가 조금만 내려도 체결되지 않고 환불될 수 있습니다'}
    </p>
  );
}

/** 이만큼 답이 없으면 늦는다고 말하고 같은 값으로 다시 보낼 수 있게 한다 */
const SLOW_MS = 45_000;

/**
 * 클레임 폼 문구 — 공개 의뢰(보증금 인보이스를 받는다) / 지정 거래(보증금 없이 바로 수락). 갈래를 한 곳에 둔다 —
 * 문장마다 삼항을 두면 한 문장이 두 조각으로 따로 골라져 붙는다
 */
const CLAIM_TEXT = {
  public: {
    open: '사줄게', waiting: '보증금 인보이스를 받는 중…', failed: '보증금 인보이스를 받지 못했습니다',
    act: '결제하면', when: '결제하세요', submit: '보증금 인보이스 받기',
  },
  designated: {
    open: '수락하기', waiting: '수락을 확인하는 중…', failed: '수락하지 못했습니다',
    act: '수락하면', when: '수락하세요', submit: '수락',
  },
} as const;

function ClaimForm({ order, invoice }: { order: OnchainOrder; invoice: DepositInvoice | undefined }) {
  const orderId = order.orderId;
  // 지정 거래 — 보증금 인보이스가 없다. 답은 오더가 `bonded`로 바뀌는 것(이 카드가 내 거래로 옮겨 간다)
  const designated = Boolean(order.designatedSponsor);
  const text = CLAIM_TEXT[designated ? 'designated' : 'public'];
  const [riskAccepted, setRiskAccepted] = useState(false);
  /** 지정 거래는 위험 고지를 체크해야 보낼 수 있다 */
  const blocked = designated && !riskAccepted;
  const notice = useSyncExternalStore(subscribeNotices, getNoticesSnapshot)[orderId];
  const pending = pendingClaim(orderId, invoice?.receivedAt, notice?.receivedAt);
  const [, rerender] = useState(0);
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [feerate, setFeerate] = useState('');
  const [fees, setFees] = useState<FeeEstimates | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 지금 수수료 추정치로 채워 둔다 — 비워두면 대충 넣은 값이 릴리스를 멈추게 한다.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const chain = new MempoolChainAdapter({
      network: order.network === 'mainnet' ? 'mainnet' : order.network === 'testnet' ? 'testnet' : 'signet',
    });
    void chain.getFeeEstimates().then(r => {
      if (!alive || !r.known) return;
      setFees(r.value);
      setFeerate(prev => prev || String(r.value.halfHour));
    });
    return () => { alive = false; };
  }, [open, order.network]);

  // 답을 기다리는 동안 1초마다 다시 그린다 — 늦는다는 안내가 제때 뜨게
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => rerender(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [pending]);

  /** 던지지 않는다 — 실패는 false. 다시 보내기 버튼도 이걸 부른다 */
  async function send(claim: MyClaim): Promise<boolean> {
    let ok = false;
    try {
      const sponsorXonly = await myOrderXonly(orderId);
      // ⚠️ 먼저 기억해 둔다. 발행만 하고 못 적어두면 나중에 **사전서명을 만들 수 없다.**
      rememberMyClaim({ ...claim, requestedAt: Date.now() });
      ok = (await publishOnchainClaim({
        orderId, sponsorXonly, payoutAddress: claim.payoutAddress, feerateSatPerVb: claim.feerateSatPerVb,
      })).success;
    } catch (e) {
      console.error('[온체인] 클레임 발행 실패', e);
    }
    // 못 보냈으면 잊는다 — **던진 경우도**. 남겨 두면 데몬이 모르는 값을 붙든 채 폼이 "기다리는 중"으로 잠긴다
    if (!ok) forgetMyClaim(orderId);
    rerender(n => n + 1);
    return ok;
  }

  if (pending) {
    const slow = Date.now() - (pending.requestedAt ?? 0) > SLOW_MS;
    return (
      <div style={styles.waiting}>
        <p style={styles.waitingLine}>
          <span className="spinner" /> {text.waiting}
        </p>
        {slow && (
          <>
            <p style={styles.hint}>응답이 늦습니다. 이 화면을 열어 두면 도착하는 대로 뜹니다.</p>
            <button style={styles.ghost} onClick={() => void send(pending)}>같은 값으로 다시 보내기</button>
          </>
        )}
      </div>
    );
  }

  const rejected = notice && getMyClaim(orderId)?.requestedAt !== undefined;

  if (!open && !rejected) {
    return (
      <button style={styles.claim} onClick={() => setOpen(true)}>{text.open}</button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const rate = Number(feerate);
    if (blocked) return setError(DESIGNATED_COPY.acceptIncomplete);
    const addrProblem = addressProblem(address, order.network);
    if (addrProblem) return setError(addrProblem);
    if (!Number.isFinite(rate) || rate <= 0) return setError('수수료율을 숫자로 입력하세요.');
    // 어드민과 **같은 경계**로 미리 본다 — 틀린 값은 어드민이 거절하고, 통과한 값이
    // 릴리스를 멈추는 일은 없어야 한다.
    const feeProblem = releaseFeerateProblem({
      feerateSatPerVb: rate,
      fastestSatPerVb: fees?.fastest,
      amountSat: order.amountSat,
      releaseFeeSat: Math.ceil(TYPICAL_SETTLEMENT_VSIZE * rate),
      dustSat: 330,
    });
    if (feeProblem) return setError(feeProblem);

    setBusy(true);
    try {
      clearNotice(orderId); // 지난 거절은 이 요청과 상관없다
      const ok = await send({ orderId, payoutAddress: address.trim(), feerateSatPerVb: rate });
      if (!ok) setError('발행에 실패했습니다. 다시 시도하세요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={e => void submit(e)} style={styles.form}>
      {rejected && notice && (
        <p style={styles.error}>{text.failed} — {notice.reason}</p>
      )}
      {designated && (
        <DesignatedAcceptConsent track="onchain" checked={riskAccepted} onChange={setRiskAccepted} />
      )}
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
          {fees && ` 지금 추정: 30분 ${fees.halfHour} · 1시간 ${fees.hour} sat/vB`}
        </span>
      </label>

      <div style={styles.warn}>
        {text.act} <strong>{durationText(FUNDING_WINDOW_SEC)} 안에</strong> 상대방이 입금을 컨펌시키고, 그 뒤
        <strong> {durationText(PRESIGN_WINDOW_SEC)} 안에 앱이 서명</strong>합니다. 앱을 열어둘 수 있을 때 {text.when}.
      </div>

      {error && <p style={styles.error}>{error}</p>}
      <button type="submit" style={styles.claim} disabled={busy || blocked}>
        {busy ? '보내는 중…' : text.submit}
      </button>
    </form>
  );
}

const styles = {
  waiting: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  waitingLine: { margin: 0, fontSize: 13, color: '#4338CA', display: 'flex', alignItems: 'center', gap: 8 },
  ghost: {
    alignSelf: 'flex-start' as const, padding: '6px 10px', fontSize: 12, background: '#fff', color: '#4B5563',
    border: '1px solid #D1D5DB', borderRadius: 8, cursor: 'pointer',
  },
  list: { display: 'flex', flexDirection: 'column' as const, gap: 12 },
  card: { border: '1px solid #E5E7EB', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column' as const, gap: 10 },
  cardDesignated: { borderColor: '#DDD6FE', background: '#FDFCFF' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  amount: { fontSize: 18, color: '#111827' },
  network: { fontSize: 11, color: '#6B7280', background: '#F3F4F6', padding: '2px 8px', borderRadius: 4 },
  reserve: { margin: 0, fontSize: 12, color: '#6B7280' },
  reserveClose: { margin: 0, fontSize: 12, color: '#B45309' },
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
