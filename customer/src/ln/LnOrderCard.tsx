/**
 * 라이트닝 의뢰 카드 — 내가 참여한 의뢰는 어느 탭에서 보든 이 카드 하나 (2026-09-24)
 *
 * 무엇을 보여주고 무엇을 하게 할지는 `card-view.ts`가 데이터로 정한다. 여기는 그리고, 버튼을 발행에
 * 잇기만 한다. 탭마다 다른 컴포넌트를 두면 한쪽에만 있는 버튼이 생긴다 — 에스크로 결제가 의뢰하기
 * 탭에서만 됐던 게 그 사고다. 온체인 `OnchainOrderCard`와 같은 원칙.
 */
import { useState } from 'react';
import {
  BUTTON, canSendAccountInfo, guarded, remainingText, type AccountInfo, type Order, type PriceTracker,
} from '@sajwo-tracker/shared';
import { LN_CLOSE_REASON_LABEL, isLnCloseReason } from '@sajwo-tracker/shared/ln';
import { publishAccountInfo, publishNotification, publishOrderRequest } from '../buyer/nostr/publish';
import { deleteOrder, markPublished, setAccountInfo } from '../buyer/order-store';
import { AccountInfoModal } from '../buyer/components/AccountInfoModal';
import { publishAccountReveal, publishRemitRequest } from '../sponsor/nostr/claim';
import { clearClaimError } from '../sponsor/claim-error-store';
import { SponsorInvoiceForm } from '../sponsor/components/SponsorInvoiceForm';
import type { LnAction } from './card-view';
import { LnPayPanel } from './LnPayPanel';
import { useLnCard } from './use-ln-card';
import { ui } from '../ui';

interface Props {
  orderId: string;
  /** 보존이 끝나 라이브 스토어에 없는 오더 (내 거래의 IDB 사본) */
  archived?: Order | null;
  tracker: PriceTracker;
  /** 상세·채팅으로 간다. 상세 화면 안에서는 넘기지 않는다 */
  onOpen?: (orderId: string) => void;
  /** 로컬 기록 지우기 — 의뢰하기 탭(내 의뢰 목록 관리)에서만 */
  allowDelete?: boolean;
}

/** 카드 하나가 깨져도 목록·다른 카드는 그대로 */
export const LnOrderCard = guarded(LnOrderCardBody, '이 의뢰 카드');

function LnOrderCardBody({ orderId, archived, tracker, onOpen, allowDelete }: Props) {
  const { view, order, local, now } = useLnCard(orderId, archived);
  const [busy, setBusy] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  async function run(key: string, fn: () => Promise<boolean>, failMessage: string) {
    setBusy(key);
    try {
      if (!(await fn())) alert(failMessage);
    } catch {
      alert(failMessage);
    } finally {
      setBusy(null);
    }
  }

  const publish = () => run('publish', async () => {
    if (!local) return false;
    const r = await publishOrderRequest(local);
    if (r.success && r.raw) markPublished(orderId, r.raw);
    return r.success;
  }, '의뢰를 올리지 못했습니다.');

  const confirmPaid = () => {
    if (!confirm('실제로 원화 입금이 확인되었습니까?\n\n'
      + '입금되지 않은 상태에서 컨펌하면 BTC가 상대방에게 전송되고, 이후 돌려받을 수 없습니다.')) return;
    void run('confirm', async () => (await publishNotification({ orderId }, 'payment-confirm')).success,
      '입금 컨펌을 보내지 못했습니다.');
  };

  const cancel = () => {
    if (!confirm('이 의뢰를 취소하시겠습니까?')) return;
    void run('cancel', async () => (await publishNotification({ orderId }, 'cancel-request')).success,
      '취소 요청을 보내지 못했습니다.');
  };

  const sendAccount = async (info: AccountInfo) => {
    // 버튼이 안 보여도 여기 닿는 길이 생길 수 있다 — 발행 직전에 한 번 더 본다(후원자 보호 I-009)
    const sponsorPubkey = order?.sponsorPubkey ?? local?.sponsorPubkey;
    if (!canSendAccountInfo(view.state ?? undefined) || !sponsorPubkey) {
      alert('아직 후원자가 받을 인보이스를 등록하지 않았습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    await run('account', async () => {
      const r = await publishAccountInfo({ orderId, sponsorPubkey }, info);
      if (r.success) {
        setAccountInfo(orderId, info);
        setAccountOpen(false);
      }
      return r.success;
    }, '계좌 정보를 보내지 못했습니다.');
  };

  const remit = () => {
    if (!order) return;
    if (!confirm('지정된 금액을 지정된 계좌로 송금하셨습니까?\n\n'
      + '송금하지 않고 송금을 주장할 경우, 분쟁 발생 시 불리하게 적용될 수 있습니다.')) return;
    void run('remit', () => publishRemitRequest(order), '송금 완료를 알리지 못했습니다.');
  };

  const reveal = () => {
    if (!order) return;
    if (!confirm('계좌정보를 Admin에게 공개하시겠습니까?\n원래 전달받은 계좌정보의 커밋먼트와 대조 검증됩니다.')) return;
    void run('reveal', () => publishAccountReveal(order), '계좌정보를 공개하지 못했습니다.');
  };

  const remove = () => {
    if (confirm('이 의뢰를 목록에서 지우시겠습니까?')) deleteOrder(orderId);
  };

  const roleLabel = view.role === 'customer' ? '내 의뢰' : view.role === 'sponsor' ? '내가 사주는 중' : null;
  const closeReason = view.closeReason && isLnCloseReason(view.closeReason) ? LN_CLOSE_REASON_LABEL[view.closeReason] : null;

  function renderAction(action: LnAction) {
    switch (action.kind) {
      case 'publish':
        return (
          <button className="btn btn-publish" disabled={busy !== null} onClick={() => void publish()}>
            {busy === 'publish' ? '올리는 중...' : '오더북에 올리기'}
          </button>
        );
      case 'pay':
        return <LnPayPanel purpose={action.purpose} bolt11={action.bolt11} price={view.price} tracker={tracker} />;
      case 'send-account':
        return (
          <button className="btn btn-publish" disabled={busy !== null} onClick={() => setAccountOpen(true)}>
            {BUTTON.sendAccount}
          </button>
        );
      case 'confirm-paid':
        return (
          <button className="btn btn-publish" disabled={busy !== null} onClick={confirmPaid}>
            {busy === 'confirm' ? '보내는 중...' : BUTTON.confirmPaid}
          </button>
        );
      case 'register-invoice':
        return order ? (
          <SponsorInvoiceForm order={order} notice={action.notice} onSubmitted={() => clearClaimError(orderId)} />
        ) : null;
      case 'remit':
        return <RemitBlock price={view.price} account={action.account} busy={busy === 'remit'} onRemit={remit} />;
      case 'reveal':
        return (
          <div style={styles.reveal}>
            <button style={styles.revealBtn} disabled={busy !== null} onClick={reveal}>
              {busy === 'reveal' ? '보내는 중...' : '계좌정보 공개'}
            </button>
            <span style={styles.revealHint}>
              어드민이 분쟁 중재를 위해 계좌정보 공개를 요청했습니다. 받은 계좌를 그대로 제출하면 커밋먼트와 대조됩니다.
            </span>
          </div>
        );
    }
  }

  return (
    <div style={view.terminal ? { ...styles.card, ...styles.cardDone } : styles.card}>
      <div style={styles.top}>
        <span style={ui.price}>{view.price.toLocaleString()}원</span>
        {view.deadline > 0 && !view.terminal && (
          <span style={{ ...ui.timeLeft, color: view.deadline - now < 3600 ? '#DC2626' : '#6B7280' }}>
            {remainingText(view.deadline - now, '기한 지남')}
          </span>
        )}
      </div>

      <div style={ui.statusRow}>
        <span style={{ ...styles.badge, background: view.badge.bg, color: view.badge.color }}>{view.badge.label}</span>
        <span style={styles.stepTitle}>{view.title}</span>
        {view.isMyTurn
          ? <span style={styles.turnMine}>지금 내 차례</span>
          : view.waitingFor && !view.terminal && <span style={styles.turnOther}>{view.waitingFor} 차례</span>}
        {roleLabel && <span style={styles.role}>{roleLabel}</span>}
      </div>

      {/* 얼마에 거래했는지 — 금액만으로는 단가가 안 보인다(2026-09-25). 승인 때 시세로 정한 지급액이 기준이다 */}
      {order?.payoutSat && view.price > 0 && (
        <p style={styles.note}>
          1 BTC = {Math.round((view.price * 1e8) / order.payoutSat).toLocaleString()}원
          {view.role === 'sponsor' ? ` · 받을 ${order.payoutSat.toLocaleString()} sats` : ''}
        </p>
      )}

      {local && (local.memo || local.coupangOrderId || local.fixedAccountInfo) && (
        <div style={styles.localInfo}>
          {local.memo && <span>{local.memo}</span>}
          {local.coupangOrderId && <span>쿠팡 #{local.coupangOrderId}</span>}
          {local.fixedAccountInfo && (
            <span>{local.fixedAccountInfo.bankName} {local.fixedAccountInfo.accountNumber} ({local.fixedAccountInfo.holderName})</span>
          )}
        </div>
      )}

      {closeReason && <p style={styles.note}>종료 사유: {closeReason}</p>}
      {view.disbursed && <p style={{ ...styles.note, color: '#059669' }}>BTC 지급 완료</p>}
      {view.notes.map(n => <p key={n} style={styles.note}>{n}</p>)}

      {view.actions.length > 0 && (
        <div style={styles.actions}>
          {view.actions.map(a => <div key={a.kind}>{renderAction(a)}</div>)}
        </div>
      )}

      <div style={styles.bottom}>
        <span style={styles.meta}>#{orderId}</span>
        <div style={styles.bottomBtns}>
          {onOpen && !view.draft && (
            <button style={styles.openBtn} onClick={() => onOpen(orderId)}>진행 상황 · 채팅</button>
          )}
          {view.side.cancel && (
            <button className="btn btn-danger" disabled={busy !== null} onClick={cancel}>
              {busy === 'cancel' ? '취소 중...' : '취소'}
            </button>
          )}
          {view.side.delete && allowDelete && <button className="btn btn-danger" onClick={remove}>지우기</button>}
        </div>
      </div>

      {accountOpen && (
        <AccountInfoModal
          orderId={orderId}
          onClose={() => setAccountOpen(false)}
          onSubmit={info => void sendAccount(info)}
          submitting={busy === 'account'}
        />
      )}
    </div>
  );
}

/** 후원자가 원화를 보내는 자리 — 은행 앱으로 넘어가는 순간 보고 있는 블록이다 */
function RemitBlock({ price, account, busy, onRemit }: {
  price: number; account: AccountInfo; busy: boolean; onRemit: () => void;
}) {
  return (
    <div style={styles.account}>
      <p style={styles.accountTitle}>이 계좌로 원화를 보내세요</p>
      {/* 쿠팡 가상계좌는 **금액이 1원만 달라도 입금으로 인식되지 않는다** — 금액을 계좌 바로 옆에 */}
      <div style={styles.remitAmountRow}>
        <b style={styles.remitAmount}>{price.toLocaleString()}원</b>
        <button type="button" style={styles.copyBtn} onClick={() => void navigator.clipboard.writeText(String(price))}>
          금액 복사
        </button>
      </div>
      <p style={styles.accountDetail}>
        {account.bankName} {account.accountNumber}
        <button type="button" style={styles.copyBtn} onClick={() => void navigator.clipboard.writeText(account.accountNumber)}>
          계좌 복사
        </button>
      </p>
      <p style={styles.accountDetail}>예금주: {account.holderName}</p>
      {/* 안 눌러도 고객이 컨펌하면 끝나지만(invoiced → paid), 누르면 고객이 그때부터 확인한다 */}
      <p style={styles.remitReminder}>
        보내셨으면 아래 <b>'{BUTTON.remitted}'</b>를 꼭 눌러주세요. 고객이 그때부터 입금을 확인합니다.
      </p>
      <button style={styles.remitBtn} disabled={busy} onClick={onRemit}>
        {busy ? '보내는 중...' : BUTTON.remitted}
      </button>
    </div>
  );
}

const styles = {
  card: {
    background: '#fff', borderRadius: 10, padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    display: 'flex', flexDirection: 'column' as const, gap: 8,
  },
  cardDone: { background: '#FAFAFA', boxShadow: 'none', border: '1px solid #E5E7EB' },
  top: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  badge: { display: 'inline-block', borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 600 as const },
  stepTitle: { fontSize: 14, fontWeight: 600 as const, color: '#111827' },
  turnMine: {
    fontSize: 11, fontWeight: 700 as const, color: '#fff', background: '#4F46E5', borderRadius: 999, padding: '2px 8px',
  },
  turnOther: {
    fontSize: 11, fontWeight: 600 as const, color: '#6B7280', background: '#F3F4F6', borderRadius: 999, padding: '2px 8px',
  },
  role: { fontSize: 11, fontWeight: 600 as const, color: '#4338CA', background: '#EEF2FF', borderRadius: 6, padding: '2px 8px' },
  localInfo: { display: 'flex', flexWrap: 'wrap' as const, gap: 8, fontSize: 12, color: '#6B7280' },
  note: { margin: 0, fontSize: 12, color: '#6B7280', lineHeight: 1.5 },
  actions: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  bottom: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const },
  bottomBtns: { display: 'flex', gap: 6, flexWrap: 'wrap' as const },
  meta: { fontSize: 12, color: '#9CA3AF' },
  openBtn: {
    background: '#EEF2FF', color: '#4338CA', border: 'none', borderRadius: 6, padding: '8px 12px',
    fontSize: 13, fontWeight: 600 as const, cursor: 'pointer',
  },
  reveal: {
    display: 'flex', alignItems: 'center', gap: 12, background: '#FEF3C7', border: '1px solid #FDE68A',
    borderRadius: 8, padding: '10px 12px',
  },
  revealBtn: {
    padding: '8px 14px', fontSize: 13, fontWeight: 600 as const, color: '#fff', background: '#D97706',
    border: 'none', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  revealHint: { fontSize: 11, color: '#92400E', lineHeight: 1.4 },
  account: {
    background: '#F9FAFB', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column' as const, gap: 4,
  },
  accountTitle: { fontSize: 12, fontWeight: 600 as const, color: '#333', margin: 0 },
  accountDetail: { fontSize: 13, color: '#555', margin: 0, fontFamily: 'monospace' },
  remitAmountRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 8px' },
  remitAmount: { fontSize: 18, color: '#111827' },
  copyBtn: {
    marginLeft: 6, padding: '2px 8px', background: 'transparent', color: '#4F46E5', border: '1px solid #C7D2FE',
    borderRadius: 4, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
  },
  remitReminder: { margin: '8px 0 0 0', fontSize: 12, lineHeight: 1.6, color: '#92400E' },
  remitBtn: {
    marginTop: 4, alignSelf: 'flex-start' as const, background: '#059669', color: '#fff', border: 'none', borderRadius: 6,
    padding: '8px 16px', fontSize: 14, fontWeight: 600 as const, cursor: 'pointer',
  },
};
