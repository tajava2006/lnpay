/**
 * 온체인 거래 카드 — 역할별 액션 (O-007 · T-106). 목록·상세가 같은 카드를 쓴다
 *
 * 역할은 **pubkey 비교로 유도**한다. 칼럼을 따로 두지 않는다(라이트닝과 같은 규칙).
 *
 * ⚠️ 이 화면의 핵심 규칙:
 *   ① **릴리스는 자동이 아니다**(O-007). 고객이 은행 입금을 눈으로 확인하고 누른다
 *   ② **원화 송금 전에 확인시킨다**(T-106) — 타임락, 그리고 **펀딩이 정말 체인에 있는지**.
 *      모르면 막는다
 *   ③ **서명은 내 기록으로 다시 만든 tx에만** 한다. 받은 PSBT의 "받는 주소"가
 *      내가 기대한 곳이 아니면 버튼이 안 열린다
 *   ④ **마감이 지난 행동은 버튼부터 없다**. 늦은 계좌·늦은 송금은 어드민도
 *      받지 않는다 — 화면이 열어두면 원화만 헛되이 나간다
 */
import { useSyncExternalStore } from 'react';
import { ErrorBoundary, InvoicePayBlock, useNow } from '@sajwo-tracker/shared';
import { onchainStateDisplay, settlementSummary, type OnchainOrder } from '@sajwo-tracker/shared/onchain';
import { onchainCardView } from '../card-view';
import type { SignRequest } from '../sign-request-store';
import { clearNotice, getNoticesSnapshot, subscribeNotices } from '../notice-store';
import { ChainLinks } from './ChainLinks';
import { DeadlineCountdown } from './DeadlineCountdown';
import { EscrowAddressPanel } from './EscrowAddressPanel';
import { OnchainProgressBar } from './OnchainProgressBar';
import { OnchainChat } from './OnchainChat';
import { RecoveryPanel } from './RecoveryPanel';
import { styles } from './card-styles';
import { CancelOrderPanel } from './CancelOrderPanel';
import { PresignStatus } from './PresignStatus';
import { AccountInfoForm } from './AccountInfoForm';
import { RemitPanel } from './RemitPanel';
import { SignPanel } from './SignPanel';
import { DisputeButton } from './DisputeButton';

/**
 * 주문 하나. 목록과 상세가 **같은 카드를 쓴다** — 둘이 갈리면 한쪽에만 있는
 * 버튼이 생기고, 그게 "왜 여기선 안 보이지"가 된다.
 */
interface OnchainOrderCardProps {
  order: OnchainOrder;
  role: 'customer' | 'sponsor';
  myPubkey: string;
  invoiceBolt11?: string;
  signRequests: SignRequest[];
  onSelect?: (orderId: string) => void;
}

/**
 * 거래 카드. 회수 칸은 **따로 가둔다** — 카드의 다른 칸이 깨져도 타임락 회수(어드민이 사라졌을 때의 마지막
 * 탈출구)는 남아야 한다.
 */
export function OnchainOrderCard(props: OnchainOrderCardProps) {
  return (
    <div style={styles.card}>
      <ErrorBoundary label="이 거래 카드">
        <OnchainOrderCardBody {...props} />
      </ErrorBoundary>
      {props.role === 'customer' && (
        <ErrorBoundary label="자금 회수">
          <RecoveryPanel order={props.order} />
        </ErrorBoundary>
      )}
    </div>
  );
}

function OnchainOrderCardBody({ order, role, myPubkey, invoiceBolt11, signRequests, onSelect }: OnchainOrderCardProps) {
  const badge = onchainStateDisplay(order.state);
  const notices = useSyncExternalStore(subscribeNotices, getNoticesSnapshot);
  const notice = notices[order.orderId];
  const now = useNow();
  // 무엇을 띄울지는 `onchainCardView`가 정한다 — 여기는 그리기만
  const view = onchainCardView(order, role, now, signRequests);

  return (
    <>
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
          {/* 얼마에 거래했는지 — 금액·수량만으로는 단가가 안 보인다(2026-09-25). 입금 컨펌 시점 시세다 */}
          <span style={styles.sub}> · 1 BTC = {Math.round((order.priceKrw * 1e8) / order.amountSat).toLocaleString()}원</span>
          {role === 'sponsor' && order.payoutSat !== undefined && (
            <span style={styles.sub}> · 받을 {order.payoutSat.toLocaleString()} sats</span>
          )}
        </p>
      )}

      {order.state === 'settling' && order.settlementKind && (
        <p style={styles.okText}>{settlementSummary(role, order.settlementKind)}</p>
      )}

      {notice && (
        <div style={styles.danger}>
          <p style={styles.dangerText}>운영자: {notice.reason}</p>
          <button style={styles.ghost} onClick={() => clearNotice(order.orderId)}>확인</button>
        </div>
      )}

      <DeadlineCountdown order={order} role={role} />

      <ChainLinks order={order} />

      <OnchainProgressBar order={order} role={role} accountInfoSent={Boolean(order.accountSentAt)} />

      {invoiceBolt11 && (
        <div style={styles.section}>
          <p style={styles.sectionTitle}>보증금 결제</p>
          <InvoicePayBlock bolt11={invoiceBolt11} />
        </div>
      )}

      {view.cancel && <CancelOrderPanel order={order} />}

      {view.escrowAddress && <EscrowAddressPanel order={order} role="customer" />}

      {view.presignStatus && <PresignStatus order={order} now={now} />}

      {view.account === 'late' && <p style={styles.dangerText}>계좌 공개 마감이 지났습니다. 거래가 환불로 넘어갑니다.</p>}
      {view.account === 'form' && <AccountInfoForm order={order} />}

      {view.remit && <RemitPanel order={order} now={now} />}

      {view.actionable.map(r => (
        <SignPanel
          key={`${r.purpose}:${r.outpoint ?? ''}`}
          order={order}
          role={role}
          request={r}
        />
      ))}

      <DisputeButton order={order} role={role} now={now} />

      {view.chatOpen && <OnchainChat order={order} myPubkey={myPubkey} role={role} />}
    </>
  );
}
