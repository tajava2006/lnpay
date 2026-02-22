import { useState } from 'react';
import type { CustomerOrder } from '../types';
import { getDisplayMeta, isDeletable } from '../order-states';
import { publishOrderRequest } from '../nostr/publish';
import { markPublished, deleteOrder } from '../order-store';
import { InvoiceModal } from './InvoiceModal';

interface Props {
  order: CustomerOrder;
}

export function OrderRow({ order }: Props) {
  const [publishing, setPublishing] = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);

  const meta = getDisplayMeta(order);
  const showPublish = !order.raw && !order.adminState;
  const showPayment = order.adminState === 'verified' && order.bolt11;
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
        <td>{order.memo}</td>
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
          <div style={{ display: 'flex', gap: 8 }}>
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
          onClose={() => setShowInvoice(false)}
        />
      )}
    </>
  );
}
