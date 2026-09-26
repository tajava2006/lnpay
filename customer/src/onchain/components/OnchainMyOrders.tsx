/**
 * 내 온체인 거래 목록 — 보낸 의뢰(답 대기)·보증금 인보이스·거래 카드
 *
 * 역할은 **pubkey 비교로 유도**한다. 칼럼을 따로 두지 않는다(라이트닝과 같은 규칙).
 * 카드와 그 규칙은 `OnchainOrderCard.tsx`에 있다.
 */
import { useSyncExternalStore } from 'react';
import { InvoicePayBlock } from '@sajwo-tracker/shared';
import { getOnchainOrdersSnapshot, myOnchainOrders, roleIn, subscribeOnchainOrders } from '../store';
import { getDepositInvoicesSnapshot, subscribeDepositInvoices } from '../deposit-store';
import { getSignRequestsSnapshot, signRequestsFor, subscribeSignRequests } from '../sign-request-store';
import {
  forgetPendingRequest, getPendingRequestsSnapshot, subscribePendingRequests,
} from '../pending-request-store';
import { depositAmountText } from '../deposit-amount';
import { ui } from '../../ui';
import { styles } from './card-styles';
import { OnchainOrderCard } from './OnchainOrderCard';

interface Props {
  myPubkey: string | null;
  /** 카드를 누르면 그 주문만 보는 화면으로 간다 (URL에 주문이 남는다) */
  onSelectOrder?: (orderId: string) => void;
}

export function OnchainMyOrders({ myPubkey, onSelectOrder }: Props) {
  useSyncExternalStore(subscribeOnchainOrders, getOnchainOrdersSnapshot);
  const invoices = useSyncExternalStore(subscribeDepositInvoices, getDepositInvoicesSnapshot);
  const signRequests = useSyncExternalStore(subscribeSignRequests, getSignRequestsSnapshot);
  const pendingRequests = useSyncExternalStore(
    subscribePendingRequests, getPendingRequestsSnapshot,
  );

  if (!myPubkey) return <p style={ui.empty}>키를 준비하는 중…</p>;
  const orders = myOnchainOrders(myPubkey);

  /**
   * ⚠️ **오더가 아직 없는 보증금 인보이스**가 따로 있다.
   *
   * 의뢰 등록은 **보증금 결제가 곧 등록**이라, 결제 전에는 오더 자체가
   * 존재하지 않는다. 그래서 이걸 오더 카드 안에서만 그리면 **결제할 화면이
   * 영영 안 나오고 흐름이 멈춘다**(2026-09-21 실제로 그랬다).
   */
  const orphanInvoices = Object.values(invoices).filter(
    inv => inv.bolt11 && !inv.done && !orders.some(o => o.orderId === inv.orderId),
  );

  const waiting = Object.values(pendingRequests);

  return (
    <div style={styles.list}>

      {orders.length === 0 && orphanInvoices.length === 0 && waiting.length === 0 && (
        <p style={ui.empty}>아직 온체인 거래가 없습니다.</p>
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
