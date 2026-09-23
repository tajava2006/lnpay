/**
 * 내 온체인 거래 — 역할별 액션 (PLAN-ONCHAIN-TRACK §9 · O-007 · T-106)
 *
 * 역할은 **pubkey 비교로 유도**한다. 칼럼을 따로 두지 않는다(라이트닝과 같은 규칙).
 *
 * ⚠️ 이 화면의 핵심 규칙:
 *   ① **릴리스는 자동이 아니다**(O-007). 고객이 은행 입금을 눈으로 확인하고 누른다
 *   ② **원화 송금 전에 확인시킨다**(T-106) — 타임락, 그리고 **펀딩이 정말 체인에 있는지**.
 *      모르면 막는다
 *   ③ **서명은 내 기록으로 다시 만든 tx에만** 한다(리뷰 #8). 받은 PSBT의 "받는 주소"가
 *      내가 기대한 곳이 아니면 버튼이 안 열린다
 *   ④ **마감이 지난 행동은 버튼부터 없다**(리뷰 #8). 늦은 계좌·늦은 송금은 어드민도
 *      받지 않는다 — 화면이 열어두면 원화만 헛되이 나간다
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { InvoicePayBlock } from '@sajwo-tracker/shared';
import {
  MempoolChainAdapter, accountDeadlineOf, canActOnSignRequest, isPast, krwDeadlineOf,
  onchainStateDisplay, presignDeadlineOf,
  type AddressFunds, type ChainQuery, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { getOnchainOrdersSnapshot, myOnchainOrders, roleIn, subscribeOnchainOrders } from '../store';
import { getDepositInvoicesSnapshot, subscribeDepositInvoices } from '../deposit-store';
import {
  clearSignRequest, getSignRequestsSnapshot, signRequestsFor, subscribeSignRequests,
  type SignRequest,
} from '../sign-request-store';
import {
  forgetPendingRequest, getPendingRequestsSnapshot, subscribePendingRequests,
} from '../pending-request-store';
import { getOnchainAccountsSnapshot, subscribeOnchainAccounts } from '../account-store';
import { clearNotice, getNoticesSnapshot, subscribeNotices } from '../notice-store';
import { getRefundAddress } from '../refund-address-store';
import { getMyClaim, rememberMyClaim } from '../claim-store';
import { depositAmountText } from '../deposit-amount';
import { buildCosignature, timelockStatus } from '../actions';
import { checkFundingOnChain, checkSignRequest, releaseNeedsPriceOverride, type SignCheck } from '../verify';
import { myOrderXonly } from '../keys';
import {
  publishOnchainAccountInfo, publishOnchainCancelRequest, publishOnchainCosign,
  publishOnchainDispute,
} from '../nostr/publish';
import { publishRemitRequestOnchain } from '../nostr/remit';
import { presignNow } from '../nostr/service';
import { DeadlineCountdown } from './DeadlineCountdown';
import { EscrowAddressPanel } from './EscrowAddressPanel';
import { OnchainProgressBar } from './OnchainProgressBar';
import { OnchainChat } from './OnchainChat';
import { RecoveryPanel } from './RecoveryPanel';
import { KeyBackup } from './KeyBackup';

interface Props {
  myPubkey: string | null;
  /** 카드를 누르면 그 주문만 보는 화면으로 간다 (URL에 주문이 남는다) */
  onSelectOrder?: (orderId: string) => void;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** 1초마다 다시 그린다 — 마감이 지나는 순간 버튼이 닫혀야 한다 */
function useNow(): number {
  const [now, setNow] = useState(nowSec);
  useEffect(() => {
    const id = setInterval(() => setNow(nowSec()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function chainFor(order: OnchainOrder): MempoolChainAdapter {
  return new MempoolChainAdapter({
    network: order.network === 'mainnet' ? 'mainnet' : order.network === 'testnet' ? 'testnet' : 'signet',
  });
}

export function OnchainMyOrders({ myPubkey, onSelectOrder }: Props) {
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

  return (
    <div style={styles.list}>
      <KeyBackup myPubkey={myPubkey} />

      {orders.length === 0 && orphanInvoices.length === 0 && waiting.length === 0 && (
        <p style={styles.empty}>아직 온체인 거래가 없습니다.</p>
      )}

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
        <OnchainOrderCard
          key={order.orderId}
          order={order}
          role={roleIn(order, myPubkey)!}
          myPubkey={myPubkey}
          invoiceBolt11={invoices[order.orderId]?.done ? undefined : invoices[order.orderId]?.bolt11}
          signRequests={signRequestsFor(signRequests, order.orderId)}
          onSelect={onSelectOrder}
        />
      ))}
    </div>
  );
}

/**
 * 주문 하나. 목록과 상세가 **같은 카드를 쓴다** — 둘이 갈리면 한쪽에만 있는
 * 버튼이 생기고, 그게 "왜 여기선 안 보이지"가 된다.
 */
export function OnchainOrderCard({ order, role, myPubkey, invoiceBolt11, signRequests, onSelect }: {
  order: OnchainOrder;
  role: 'customer' | 'sponsor';
  myPubkey: string;
  invoiceBolt11?: string;
  signRequests: SignRequest[];
  onSelect?: (orderId: string) => void;
}) {
  const badge = onchainStateDisplay(order.state);
  const notices = useSyncExternalStore(subscribeNotices, getNoticesSnapshot);
  const notice = notices[order.orderId];
  const now = useNow();

  // ⚠️ **스토어에 있다는 것만으로 띄우면 안 된다.** kind 1111은 릴레이에 남아
  // 새로고침마다 다시 배달되므로 로컬에서 지워도 되살아난다 — 진실은 FSM이다.
  const actionable = signRequests.filter(r =>
    canActOnSignRequest(order.state, r.purpose, order.settlementKind));

  const chatOpen = (order.state === 'presigned' && order.accountSentAt !== undefined)
    || order.state === 'remitted' || order.state === 'disputed'
    || (order.state === 'refunding' && order.settlementKind === 'refund:account-disputed');

  return (
    <div style={styles.card}>
      <div
        style={{ ...styles.head, ...(onSelect ? styles.clickable : {}) }}
        onClick={onSelect ? () => onSelect(order.orderId) : undefined}
      >
        <span style={{ ...styles.badge, color: badge.color, background: badge.bg }}>
          {badge.label}
        </span>
        <span style={styles.role}>{role === 'customer' ? '판매' : '구매'}</span>
        <strong style={styles.amount}>{order.amountSat.toLocaleString()} sats</strong>
        {onSelect && <span style={styles.chevron}>›</span>}
      </div>

      {order.priceKrw !== undefined && (
        <p style={styles.price}>
          확정 금액 <strong>{order.priceKrw.toLocaleString()}원</strong>
          {role === 'sponsor' && order.payoutSat !== undefined && (
            <span style={styles.sub}> · 받을 {order.payoutSat.toLocaleString()} sats</span>
          )}
        </p>
      )}

      {notice && (
        <div style={styles.danger}>
          <p style={styles.dangerText}>운영자: {notice.reason}</p>
          <button style={styles.ghost} onClick={() => clearNotice(order.orderId)}>확인</button>
        </div>
      )}

      <DeadlineCountdown order={order} />

      <OnchainProgressBar order={order} role={role} accountInfoSent={Boolean(order.accountSentAt)} />

      {invoiceBolt11 && (
        <div style={styles.section}>
          <p style={styles.sectionTitle}>보증금 결제</p>
          <InvoicePayBlock bolt11={invoiceBolt11} />
        </div>
      )}

      {role === 'customer' && order.state === 'listed' && <CancelOrderPanel order={order} />}

      {role === 'customer' && order.state === 'bonded' && (
        <EscrowAddressPanel order={order} role="customer" />
      )}

      {role === 'sponsor' && order.state === 'funded' && !order.settlementKind && (
        <PresignStatus order={order} now={now} />
      )}

      {role === 'customer' && order.state === 'presigned' && !order.accountSentAt && (
        isPast(accountDeadlineOf(order), now)
          ? <p style={styles.dangerText}>계좌 공개 마감이 지났습니다. 거래가 환불로 넘어갑니다.</p>
          : <AccountInfoForm order={order} />
      )}

      {role === 'sponsor' && order.state === 'presigned' && <RemitPanel order={order} now={now} />}

      {actionable.map(r => (
        <SignPanel
          key={`${r.purpose}:${r.outpoint ?? ''}`}
          order={order}
          role={role}
          request={r}
        />
      ))}

      <DisputeButton order={order} role={role} now={now} />

      {chatOpen && <OnchainChat order={order} myPubkey={myPubkey} role={role} />}

      {role === 'customer' && <RecoveryPanel order={order} />}
    </div>
  );
}

/**
 * 고객: 의뢰를 내린다.
 *
 * **후원자가 붙기 전에만** 보인다. 붙은 뒤에는 상대가 이미 보증금을 걸었으므로
 * 일방 취소가 없다 — 그때부터는 마감과 체인이 판정한다(§4.2).
 */
function CancelOrderPanel({ order }: { order: OnchainOrder }) {
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);

  if (!asked) {
    return (
      <div style={styles.section}>
        <button style={styles.ghost} onClick={() => setAsked(true)}>의뢰 내리기</button>
      </div>
    );
  }

  return (
    <div style={styles.section}>
      <p style={styles.warnText}>
        이 의뢰를 오더북에서 내립니다. <strong>보증금은 그대로 돌려받습니다</strong> —
        후원자가 아직 붙지 않았으니 아무도 손해를 보지 않습니다.
      </p>
      <button
        style={styles.primary}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void publishOnchainCancelRequest(order.orderId).finally(() => setBusy(false));
        }}
      >
        {busy ? '보내는 중…' : '내리기'}
      </button>
      <button style={styles.ghost} onClick={() => setAsked(false)}>그만두기</button>
    </div>
  );
}

/**
 * 후원자: 사전서명 상태.
 *
 * 사전서명은 앱이 자동으로 한다. 다만 **클레임 때 낸 받을 주소·수수료율이 이 기기에
 * 없으면**(다른 기기에서 클레임했거나 저장소가 지워졌을 때) 서명을 못 만들어 마감을
 * 넘기고 보증금을 잃는다. 그 자리에서 다시 입력받는다 — 어드민은 클레임 때 값과
 * 바이트까지 같은 tx만 받으므로 틀리게 넣으면 거절 사유가 돌아온다.
 */
function PresignStatus({ order, now }: { order: OnchainOrder; now: number }) {
  const claim = getMyClaim(order.orderId);
  const [address, setAddress] = useState('');
  const [feerate, setFeerate] = useState('');
  const [busy, setBusy] = useState(false);

  if (isPast(presignDeadlineOf(order), now)) {
    return <p style={styles.dangerText}>사전서명 마감이 지났습니다. 거래가 환불로 넘어갑니다.</p>;
  }
  if (claim) {
    return <p style={styles.okText}>앱이 자동으로 사전서명합니다. 이 화면을 열어 두세요.</p>;
  }
  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>받을 주소를 다시 입력하세요</p>
      <p style={styles.warnText}>
        이 기기에는 클레임 때 낸 받을 주소·수수료율 기록이 없습니다. <strong>그때와 똑같이</strong>
        입력하면 앱이 바로 사전서명합니다. 마감을 넘기면 보증금을 잃습니다.
      </p>
      <input style={styles.input} placeholder="받을 주소" value={address} onChange={e => setAddress(e.target.value)} />
      <input
        style={styles.input}
        placeholder="수수료율 (sat/vB)"
        inputMode="decimal"
        value={feerate}
        onChange={e => setFeerate(e.target.value.replace(/[^0-9.]/g, ''))}
      />
      <button
        style={styles.primary}
        disabled={busy || !address.trim() || !(Number(feerate) > 0)}
        onClick={() => {
          rememberMyClaim({ orderId: order.orderId, payoutAddress: address.trim(), feerateSatPerVb: Number(feerate) });
          setBusy(true);
          void presignNow(order).finally(() => setBusy(false));
        }}
      >
        {busy ? '서명 중…' : '사전서명하기'}
      </button>
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
      <p style={styles.sectionTitle}>입금받을 계좌 (15분 안에)</p>
      <p style={styles.warnText}>
        늦으면 거래가 취소되고 <strong>보증금을 잃습니다.</strong> 계좌는 후원자에게만
        암호화되어 전달됩니다. 틀린 계좌를 주면 후원자가 이의를 내고, 판정에 따라 보증금을 잃을 수 있습니다.
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

/**
 * 후원자: 원화 송금.
 *
 * 버튼은 **넷이 다 맞을 때만** 열린다 (리뷰 #8):
 *   - 운영자가 **고객이 계좌를 보냈다고 확인**했다(`accountSentAt`) — 계좌 스토어에
 *     뭔가 있다는 것만으로는 부족하다
 *   - 송금 마감 전이다 — 지나면 어드민이 받지 않고 환불로 간다
 *   - **펀딩이 체인에 약정 금액으로 있다** — 내가 직접 본다
 *   - 타임락 잔여가 충분하다(T-106)
 */
function RemitPanel({ order, now }: { order: OnchainOrder; now: number }) {
  const [funds, setFunds] = useState<ChainQuery<AddressFunds> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const accounts = useSyncExternalStore(subscribeOnchainAccounts, getOnchainAccountsSnapshot);
  const account = order.accountSentAt ? accounts[order.orderId] : undefined;

  useEffect(() => {
    let alive = true;
    if (!order.escrowAddress) return;
    void chainFor(order).getAddressFunds(order.escrowAddress).then(r => { if (alive) setFunds(r); });
    return () => { alive = false; };
  }, [order]);

  const funding = checkFundingOnChain(order, funds);
  const status = timelockStatus(order, funding.ok ? funding.confirmations : undefined);
  const deadlinePassed = order.accountSentAt !== undefined && isPast(krwDeadlineOf(order), now);
  const canRemit = Boolean(account) && funding.ok && status.safeToRemit && !deadlinePassed;

  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>원화 송금</p>

      {account ? (
        <div style={styles.account}>
          <p style={styles.accountLine}>
            <strong>{account.accountInfo.bankName}</strong> {account.accountInfo.accountNumber}
          </p>
          <p style={styles.accountLine}>예금주 {account.accountInfo.holderName}</p>
          {order.priceKrw !== undefined && (
            <p style={styles.accountAmount}>
              보낼 금액 <strong>{order.priceKrw.toLocaleString()}원</strong>
            </p>
          )}
        </div>
      ) : (
        <p style={styles.warnText}>
          {order.accountSentAt
            ? '계좌 정보를 아직 받지 못했습니다. 잠시 후 다시 보세요.'
            : '고객이 계좌를 보내기를 기다리는 중입니다.'}
        </p>
      )}

      <p style={funding.ok ? styles.okText : styles.warnText}>
        {funding.ok ? `에스크로 확인: 약정 금액이 체인에 있습니다 (${funding.confirmations} 컨펌)` : funding.reason}
      </p>
      <p style={status.safeToRemit ? styles.okText : styles.warnText}>{status.reason}</p>
      {deadlinePassed && (
        <p style={styles.dangerText}>송금 마감이 지났습니다. <strong>원화를 보내지 마세요</strong> — 거래가 환불로 넘어갑니다.</p>
      )}
      <p style={styles.warnText}>
        <strong>즉시 이체만 사용하세요.</strong> 지연 이체는 시간 안에 도착하지 않아
        보증금을 잃습니다.
      </p>
      <button
        style={canRemit ? styles.primary : styles.disabled}
        disabled={!canRemit || busy || sent}
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

/**
 * 서명 요청 — 릴리스·환불·분쟁·구조 공용. **내 기록으로 다시 만든 tx에만 서명한다.**
 *
 * 받는 주소가 내가 기대한 곳(환불이면 내가 낸 환불 주소, 후원자승이면 내가 낸 받을
 * 주소)이 아니면 버튼이 안 열린다. 이 기기가 환불 주소를 모르면(다른 기기에서 키를
 * 가져온 경우) **유저가 다시 입력**하게 해서 대조한다 — 보여주고 "맞다"를 누르게 하면
 * 대조가 아니다.
 */
function SignPanel({ order, role, request }: {
  order: OnchainOrder;
  role: 'customer' | 'sponsor';
  request: SignRequest;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<SignCheck | null>(null);
  const [typedRefund, setTypedRefund] = useState('');
  const [override, setOverride] = useState(false);
  const stale = request.purpose === 'release' && releaseNeedsPriceOverride(order, Date.now());

  useEffect(() => {
    let alive = true;
    void (async () => {
      const myXonly = await myOrderXonly(order.orderId);
      const result = checkSignRequest({
        order,
        purpose: request.purpose,
        psbt: request.psbt,
        role,
        myXonly,
        refundAddress: getRefundAddress(order.orderId) ?? (typedRefund.trim() || undefined),
        payoutAddress: getMyClaim(order.orderId)?.payoutAddress,
      });
      if (alive) setCheck(result);
    })();
    return () => { alive = false; };
  }, [order, request, role, typedRefund]);

  const title = request.purpose === 'release' ? '릴리스 서명 (비트코인 지급)'
    : request.purpose === 'refund' ? '환불 서명 (에스크로 회수)'
    : request.purpose === 'rescue' ? '구조 서명 (약정 밖의 자금 돌려받기)'
    : '분쟁 판정 집행 서명';

  async function sign() {
    if (!check?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const signed = await buildCosignature(order.orderId, check);
      if (!signed.ok) return setError(signed.reason);
      const result = await publishOnchainCosign(order.orderId, request.purpose, signed.psbt);
      if (!result.success) return setError('발행에 실패했습니다. 다시 시도하세요.');
      clearSignRequest(request);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>{title}</p>

      {!check ? (
        <p style={styles.warnText}>요청을 내 기록과 대조하는 중…</p>
      ) : !check.ok ? (
        <>
          <p style={styles.dangerText}>⚠️ {check.reason} — 서명하지 마세요.</p>
          {check.needsRefundAddress && (
            <input
              style={styles.input}
              placeholder="의뢰 때 낸 환불 주소를 입력하세요"
              value={typedRefund}
              onChange={e => setTypedRefund(e.target.value)}
            />
          )}
        </>
      ) : (
        <>
          <p style={styles.okText}>
            <strong>{check.amountSat.toLocaleString()} sats</strong>가 아래 주소로 갑니다
            (네트워크 수수료 {check.feeSat.toLocaleString()} sats). 내 기록으로 다시 만든 tx와 같습니다.
          </p>
          <code style={styles.addr}>{check.destination}</code>

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

/**
 * 분쟁 · 계좌 이의.
 *
 * - `remitted` — 양쪽 다 분쟁을 열 수 있다
 * - `presigned` — **후원자만**, 계좌를 받은 뒤 송금 마감 전에 "계좌를 쓸 수 없다".
 *   상태가 아니라 증거다 — 시계는 멈추지 않고, 마감이 차면 누구 과실인지 운영자가
 *   가른다(§5.2b). 고객에게는 이 단계에 분쟁 버튼이 없다(전에는 떠 있었는데
 *   누르면 어드민이 조용히 버렸다 — 리뷰 #8)
 */
function DisputeButton({ order, role, now }: {
  order: OnchainOrder;
  role: 'customer' | 'sponsor';
  now: number;
}) {
  const [busy, setBusy] = useState(false);
  const accountIssue = order.state === 'presigned' && role === 'sponsor'
    && order.accountSentAt !== undefined && !order.accountDisputedAt
    && !isPast(krwDeadlineOf(order), now);
  const remittedDispute = order.state === 'remitted';

  if (order.state === 'presigned' && role === 'sponsor' && order.accountDisputedAt) {
    return <p style={styles.warnText}>계좌 이의를 냈습니다. 채팅에 증거를 올려주세요 — 마감 시계는 멈추지 않습니다.</p>;
  }
  if (!accountIssue && !remittedDispute) return null;

  return (
    <div style={styles.section}>
      {accountIssue && (
        <p style={styles.warnText}>
          계좌를 쓸 수 없다면 알려주세요. <strong>다만 송금 마감 시계는 멈추지 않습니다</strong> —
          운영자가 확인할 수 있는 증거(이체 거절 화면 등)가 있으면 보증금을 돌려받습니다.
        </p>
      )}
      <button
        style={styles.ghost}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void publishOnchainDispute(order.orderId, accountIssue ? 'account-unusable' : 'remitted')
            .finally(() => setBusy(false));
        }}
      >
        {accountIssue ? '계좌를 쓸 수 없습니다' : '문제가 있습니다 (분쟁)'}
      </button>
    </div>
  );
}

const styles = {
  list: { display: 'flex', flexDirection: 'column' as const, gap: 14 },
  empty: { fontSize: 14, color: '#6B7280', textAlign: 'center' as const, padding: '32px 0' },
  card: { border: '1px solid #E5E7EB', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column' as const, gap: 12 },
  head: { display: 'flex', alignItems: 'center', gap: 8 },
  clickable: { cursor: 'pointer' },
  chevron: { color: '#9CA3AF', fontSize: 18, lineHeight: 1 },
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
  addr: { display: 'block', fontSize: 12, wordBreak: 'break-all' as const, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 6, padding: '6px 8px' },
};
