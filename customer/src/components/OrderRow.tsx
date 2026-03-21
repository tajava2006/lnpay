import { useState } from 'react';
import type { CustomerOrder } from '../types';
import type { AccountInfo, PriceTracker } from '@sajwo-tracker/shared';
import { getDisplayMeta, isDeletable, isCancellable, isFinal } from '../order-states';
import { publishOrderRequest, publishNotification, publishAccountInfo } from '../nostr/publish';
import { markPublished, deleteOrder, setAccountInfo } from '../order-store';
import { InvoiceModal } from './InvoiceModal';
import { AccountInfoModal } from './AccountInfoModal';
import { OrderDetail } from './OrderDetail';

interface Props {
  order: CustomerOrder;
  tracker: PriceTracker;
  now: number;
}

function formatTimeLeft(expiration: number, now: number): string {
  const diff = expiration - now;
  if (diff <= 0) return '만료됨';
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분 남음`;
  if (minutes > 0) return `${minutes}분 ${seconds}초 남음`;
  return `${seconds}초 남음`;
}

export function OrderRow({ order, tracker, now }: Props) {
  const [publishing, setPublishing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);
  const [showAccountInfo, setShowAccountInfo] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [sendingAccount, setSendingAccount] = useState(false);

  const meta = getDisplayMeta(order);
  const isParsed = order.source === 'parsed';
  const showPublish = !order.raw && !order.adminState;
  const isExpired = order.expiration > 0 && order.expiration <= now;
  const showPayment = order.adminState === 'verified' && order.bolt11 && !isExpired;
  // 수동 주문: escrowed에서 계좌 입력 모달 버튼 표시
  const showAccountBtn = !isParsed && order.adminState === 'escrowed' && order.sponsorPubkey && !order.accountInfo;
  // 계좌 전달 완료 표시 (수동/파싱 공통: escrowed에서 전달)
  const accountSent = order.accountInfo && order.adminState === 'escrowed';
  // 파싱 주문 escrowed + sponsorPubkey: 자동 전달 중 표시
  const autoSendingAccount = isParsed && order.adminState === 'escrowed' && order.sponsorPubkey && !order.accountInfo;
  const showConfirmPaid = (order.adminState === 'escrowed' && !!order.accountInfo) || order.adminState === 'remitted';
  const canCancel = isCancellable(order);
  const canDelete = isDeletable(order);
  const isUrgent = order.expiration > 0 && !isExpired && order.expiration - now < 3600;

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
    if (!confirm(
      '실제로 원화 입금이 확인되었습니까?\n\n'
      + '입금되지 않은 상태에서 컨펌하면 BTC가 상대방에게 전송되고, 이후 돌려받을 수 없습니다.',
    )) return;
    setConfirming(true);
    try {
      const result = await publishNotification(order, 'payment-confirm');
      if (!result.success) {
        alert('입금 컨펌 통보에 실패했습니다.');
      }
    } catch {
      alert('입금 컨펌 통보 중 오류가 발생했습니다.');
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

  async function handleCancel() {
    if (!confirm('이 주문을 취소하시겠습니까?')) return;
    setCancelling(true);
    try {
      const result = await publishNotification(order, 'cancel-request');
      if (!result.success) {
        alert('취소 요청에 실패했습니다.');
      }
    } catch {
      alert('취소 요청 중 오류가 발생했습니다.');
    } finally {
      setCancelling(false);
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
        <td>
          <div>{dateStr}</div>
          {order.expiration > 0 && !isFinal(order) && (
            <div style={{
              fontSize: 11,
              fontWeight: 500,
              marginTop: 2,
              color: isExpired ? '#DC2626' : isUrgent ? '#D97706' : '#999',
            }}>
              {formatTimeLeft(order.expiration, now)}
            </div>
          )}
        </td>
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
                계좌 정보 전달
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
                {confirming ? '통보 중...' : '입금 컨펌'}
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
            {canCancel && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="btn btn-danger"
              >
                {cancelling ? '취소 중...' : '취소'}
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
