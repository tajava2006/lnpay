import { useState } from 'react';
import type { CustomerOrder } from '../types';
import type { AccountInfo, PriceTracker } from '@sajwo-tracker/shared';
import { getDisplayMeta, isDeletable } from '../order-states';
import { publishOrderRequest, publishNotification, publishAccountInfo } from '../nostr/publish';
import { markPublished, deleteOrder, setAccountInfo } from '../order-store';
import { InvoiceModal } from './InvoiceModal';
import { AccountInfoModal } from './AccountInfoModal';
import { OrderDetail } from './OrderDetail';

interface Props {
  order: CustomerOrder;
  tracker: PriceTracker;
}

export function OrderRow({ order, tracker }: Props) {
  const [publishing, setPublishing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);
  const [showAccountInfo, setShowAccountInfo] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [sendingAccount, setSendingAccount] = useState(false);

  const meta = getDisplayMeta(order);
  const isParsed = order.source === 'parsed';
  const showPublish = !order.raw && !order.adminState;
  const showPayment = order.adminState === 'verified' && order.bolt11;
  // 수동 주문만 계좌 입력 모달 버튼 표시
  const showAccountBtn = !isParsed && order.adminState === 'verified' && order.sponsorPubkey && !order.accountInfo;
  // 수동 주문: verified에서 전달 완료 / 파싱 주문: escrowed에서 자동 전달 완료
  const accountSent = order.accountInfo && (
    order.adminState === 'verified' ||
    (isParsed && order.adminState === 'escrowed')
  );
  // 파싱 주문 escrowed + sponsorPubkey: 자동 전달 중 표시
  const autoSendingAccount = isParsed && order.adminState === 'escrowed' && order.sponsorPubkey && !order.accountInfo;
  const showConfirmPaid = order.adminState === 'escrowed';
  const canDelete = isDeletable(order);

  async function handlePublish() {
    setPublishing(true);
    try {
      const result = await publishOrderRequest(order);
      if (result.success && result.raw) {
        markPublished(order.orderId, result.raw);
      } else {
        alert('사줘 요청 발행에 실패했습니다.');
      }
    } catch {
      alert('사줘 요청 발행 중 오류가 발생했습니다.');
    } finally {
      setPublishing(false);
    }
  }

  async function handleConfirmPaid() {
    if (!confirm('입금 완료를 통보하시겠습니까?')) return;
    setConfirming(true);
    try {
      const result = await publishNotification(order, 'payment-confirm');
      if (!result.success) {
        alert('입금 확인 통보에 실패했습니다.');
      }
    } catch {
      alert('입금 확인 통보 중 오류가 발생했습니다.');
    } finally {
      setConfirming(false);
    }
  }

  async function handleAccountSubmit(info: AccountInfo) {
    setSendingAccount(true);
    try {
      const result = await publishAccountInfo(order, info);
      if (result.success) {
        setAccountInfo(order.orderId, info);
        setShowAccountInfo(false);
      } else {
        alert('계좌 정보 전달에 실패했습니다.');
      }
    } catch {
      alert('계좌 정보 전달 중 오류가 발생했습니다.');
    } finally {
      setSendingAccount(false);
    }
  }

  function handleDelete() {
    if (confirm('이 주문을 삭제하시겠습니까?')) {
      deleteOrder(order.orderId);
    }
  }

  const date = new Date(order.createdAt * 1000);
  const dateStr = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;

  return (
    <>
      <tr>
        <td>{order.orderId}</td>
        <td>
          {order.memo}
          {isParsed && order.fixedAccountInfo && (
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
              {order.fixedAccountInfo.bankName} {order.fixedAccountInfo.accountNumber} ({order.fixedAccountInfo.holderName})
            </div>
          )}
        </td>
        <td>{order.price.toLocaleString()}원</td>
        <td>
          <span
            style={{
              display: 'inline-block',
              padding: '4px 12px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              background: meta.bgColor,
              color: meta.textColor,
            }}
          >
            {meta.label}
          </span>
        </td>
        <td>{dateStr}</td>
        <td>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {showPublish && (
              <button
                onClick={handlePublish}
                disabled={publishing}
                className="btn btn-publish"
              >
                {publishing ? '요청 중...' : '사줘'}
              </button>
            )}
            {showPayment && (
              <button
                onClick={() => setShowInvoice(true)}
                className="btn btn-pay"
              >
                결제하기
              </button>
            )}
            {showAccountBtn && (
              <button
                onClick={() => setShowAccountInfo(true)}
                className="btn btn-publish"
              >
                결제 완료 + 계좌 전달
              </button>
            )}
            {autoSendingAccount && (
              <span style={{
                display: 'inline-block',
                padding: '4px 12px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                background: '#FEF3C7',
                color: '#D97706',
              }}>
                계좌 자동 전달 중...
              </span>
            )}
            {accountSent && (
              <span style={{
                display: 'inline-block',
                padding: '4px 12px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                background: '#D1FAE5',
                color: '#065F46',
              }}>
                계좌 전달 완료
              </span>
            )}
            {showConfirmPaid && (
              <button
                onClick={handleConfirmPaid}
                disabled={confirming}
                className="btn btn-publish"
              >
                {confirming ? '통보 중...' : '입금 확인'}
              </button>
            )}
            {order.adminState && (
              <button
                onClick={() => setShowDetail(true)}
                className="btn"
              >
                상세
              </button>
            )}
            {canDelete && (
              <button
                onClick={handleDelete}
                className="btn btn-danger"
              >
                삭제
              </button>
            )}
          </div>
        </td>
      </tr>
      {showInvoice && order.bolt11 && (
        <InvoiceModal
          orderId={order.orderId}
          bolt11={order.bolt11}
          price={order.price}
          tracker={tracker}
          onClose={() => setShowInvoice(false)}
        />
      )}
      {showAccountInfo && (
        <AccountInfoModal
          orderId={order.orderId}
          onClose={() => setShowAccountInfo(false)}
          onSubmit={handleAccountSubmit}
          submitting={sendingAccount}
        />
      )}
      {showDetail && (
        <OrderDetail
          order={order}
          onClose={() => setShowDetail(false)}
        />
      )}
    </>
  );
}
