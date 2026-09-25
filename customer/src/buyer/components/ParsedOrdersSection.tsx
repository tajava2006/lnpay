import { useState, useSyncExternalStore } from 'react';
import { canAttachParsedOrder, nowSec } from '@sajwo-tracker/shared';
import { LN_MAX_DEADLINE_LEAD_SEC, LN_MIN_CLAIM_LEAD_SEC } from '@sajwo-tracker/shared/ln';
import { subscribeParsed, getParsedSnapshot, removeParsedOrder } from '../parsed-store';
import {
  subscribe, getSnapshot, addOrder, markPublished, attachParsedToOrder,
} from '../order-store';
import { sendAccountInfoNow } from '../nostr/service';
import { publishOrderRequest } from '../nostr/publish';
import type { CustomerOrder } from '../types';
import { newOrderId } from '../order-id';
import type { ParsedOrderPayload } from '../types';

export function ParsedOrdersSection() {
  const parsed = useSyncExternalStore(subscribeParsed, getParsedSnapshot);
  const entries = Object.entries(parsed);

  if (entries.length === 0) return null;

  return (
    <div style={styles.card}>
      <h2 style={styles.title}>감지된 주문</h2>
      <p style={styles.desc}>유저스크립트가 쿠팡에서 감지한 무통장입금 주문입니다.</p>
      <div style={styles.list}>
        {entries.map(([eventId, payload]) => (
          <ParsedOrderCard key={eventId} eventId={eventId} payload={payload} />
        ))}
      </div>
    </div>
  );
}

function ParsedOrderCard({ eventId, payload }: { eventId: string; payload: ParsedOrderPayload }) {
  const [requesting, setRequesting] = useState(false);
  const [attaching, setAttaching] = useState(false);

  const orders = useSyncExternalStore(subscribe, getSnapshot);

  /**
   * 이 파싱 주문을 붙일 수 있는 기존 의뢰.
   *
   * 금액은 **정확히** 같아야 한다. 후원자는 의뢰 금액을 보내고 쿠팡은 주문 금액을
   * 기다리므로, 1원만 달라도 입금이 확인되지 않는다.
   *
   * 화면이 먼저 제안하는 게 핵심이다. 설명을 어디 적어두는 것보다, 맞는 후보가
   * 있을 때 그걸 위에 보여주는 쪽이 "이렇게 쓸 수 있다"를 확실히 알린다.
   */
  const attachable = Object.values(orders).filter(o =>
    o.price === payload.price
    && !o.fixedAccountInfo
    && canAttachParsedOrder(o.adminState, !!o.accountInfo),
  );

  async function handleAttach(orderId: string) {
    // 붙이기는 의뢰 만료와 쿠팡 계좌 만료를 **분리**시킨다. 의뢰가 3개월이어도
    // 가상계좌는 하루면 죽고, 죽은 계좌로 후원자가 송금하면 입금이 안 된다.
    // 의뢰 쪽 만료는 앱이 관리하지만 이쪽은 쿠팡이 정하므로 여기서 봐야 한다.
    const hoursLeft = (payload.expirationDate - Date.now()) / 3_600_000;
    if (hoursLeft <= 0) {
      alert('이 쿠팡 주문의 입금 기한이 이미 지났습니다. 새로 주문해 주세요.');
      return;
    }
    if (hoursLeft < 3 && !confirm(
      `입금 기한이 ${Math.floor(hoursLeft * 60)}분밖에 남지 않았습니다.\n\n`
      + '그 안에 후원자가 원화를 보내지 못하면 입금이 실패합니다. 그래도 연결할까요?',
    )) return;

    setAttaching(true);
    try {
      const ok = attachParsedToOrder(orderId, {
        coupangOrderId: payload.coupangOrderId,
        productName: payload.productName,
        bankName: payload.bankName,
        accountNumber: payload.accountNumber,
        holderName: payload.depositor,
      });
      if (!ok) {
        alert('연결에 실패했습니다. 의뢰를 다시 확인해 주세요.');
        return;
      }
      // 이미 계좌를 보낼 수 있는 단계면 지금 바로 보낸다. 그 단계로 들어올 때
      // 도는 자동 전송은 이미 지나갔으므로 여기서 직접 밀어줘야 한다.
      await sendAccountInfoNow(orderId);
      removeParsedOrder(eventId);
    } finally {
      setAttaching(false);
    }
  }

  const expirationDate = new Date(payload.expirationDate);
  const expirationStr = `${expirationDate.getFullYear()}.${String(expirationDate.getMonth() + 1).padStart(2, '0')}.${String(expirationDate.getDate()).padStart(2, '0')} ${String(expirationDate.getHours()).padStart(2, '0')}:${String(expirationDate.getMinutes()).padStart(2, '0')}`;

  async function handleRequest() {
    setRequesting(true);
    try {
      const now = nowSec();
      // 쿠팡 기한이 너무 가까우면 데몬이 받지 않는다(후원자가 붙을 틈이 없다). 조용히 사라지게 두지 않는다
      const deadline = Math.min(Math.floor(payload.expirationDate / 1000), now + LN_MAX_DEADLINE_LEAD_SEC - 60);
      if (deadline - now < LN_MIN_CLAIM_LEAD_SEC + 5 * 60) {
        alert('입금 기한이 한 시간 남짓밖에 남지 않아 후원자를 구할 수 없습니다. 새로 주문해 주세요.');
        return;
      }
      const order: CustomerOrder = {
        // 수동 주문과 같은 랜덤 id. 쿠팡 번호를 쓰면 공개 태그로 새어나간다.
        orderId: newOrderId(),
        coupangOrderId: payload.coupangOrderId,
        price: payload.price,
        memo: payload.productName,
        createdAt: now,
        expiration: deadline,
        source: 'parsed',
        fixedAccountInfo: {
          bankName: payload.bankName,
          accountNumber: payload.accountNumber,
          holderName: payload.depositor,
        },
      };

      addOrder(order);

      const result = await publishOrderRequest(order);
      if (result.success && result.raw) {
        markPublished(order.orderId, result.raw);
        removeParsedOrder(eventId);
      } else {
        alert('의뢰 등록에 실패했습니다.');
      }
    } catch {
      alert('의뢰 등록 중 오류가 발생했습니다.');
    } finally {
      setRequesting(false);
    }
  }

  function handleDismiss() {
    removeParsedOrder(eventId);
  }

  return (
    <div style={styles.orderCard}>
      <div style={styles.orderHeader}>
        <span style={styles.badge}>쿠팡 자동감지</span>
        <span style={styles.orderId}>#{payload.coupangOrderId}</span>
      </div>
      <div style={styles.orderBody}>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>상품</span>
          <span style={styles.fieldValue}>{payload.productName}</span>
        </div>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>금액</span>
          <span style={styles.fieldValue}>{payload.price.toLocaleString()}원</span>
        </div>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>입금 계좌</span>
          <span style={styles.fieldValue}>
            {payload.bankName} {payload.accountNumber} ({payload.depositor})
          </span>
        </div>
        <div style={styles.field}>
          <span style={styles.fieldLabel}>입금 기한</span>
          <span style={styles.fieldValue}>{expirationStr}</span>
        </div>
      </div>
      {attachable.length > 0 && (
        <div style={styles.attachBox}>
          <p style={styles.attachTitle}>
            금액이 같은 의뢰가 {attachable.length}건 있습니다 — 여기에 연결할까요?
          </p>
          <p style={styles.attachHint}>
            연결하면 새 의뢰를 올리지 않고 <b>이미 진행 중인 의뢰</b>에 이 계좌를 씁니다.
            후원자를 기다리며 걸어둔 의뢰가 있다면 이쪽입니다.
          </p>
          {attachable.map(o => (
            <button
              key={o.orderId}
              onClick={() => handleAttach(o.orderId)}
              disabled={attaching || requesting}
              style={styles.attachBtn}
            >
              {o.memo || '직접 입력'} · {o.price.toLocaleString()}원 에 연결
            </button>
          ))}
        </div>
      )}

      <div style={styles.orderActions}>
        <button
          onClick={handleRequest}
          disabled={requesting}
          style={styles.requestBtn}
        >
          {requesting ? '등록 중...' : '의뢰 등록'}
        </button>
        <button
          onClick={handleDismiss}
          disabled={requesting}
          style={styles.dismissBtn}
        >
          무시
        </button>
      </div>
    </div>
  );
}

const styles = {
  card: {
    background: '#FFFBEB',
    borderRadius: 12,
    padding: 20,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    marginBottom: 24,
    border: '1px solid #FDE68A',
  },
  title: {
    fontSize: 18,
    color: '#92400E',
    margin: '0 0 4px 0',
  },
  desc: {
    fontSize: 13,
    color: '#A16207',
    margin: '0 0 16px 0',
  },
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  orderCard: {
    background: 'white',
    borderRadius: 8,
    padding: 16,
    border: '1px solid #E5E7EB',
  },
  orderHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  badge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600 as const,
    background: '#FEF3C7',
    color: '#D97706',
  },
  orderId: {
    fontSize: 13,
    color: '#6B7280',
    fontFamily: 'monospace',
  },
  orderBody: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    marginBottom: 12,
  },
  field: {
    display: 'flex',
    gap: 8,
    fontSize: 13,
  },
  fieldLabel: {
    color: '#6B7280',
    minWidth: 70,
    flexShrink: 0,
  },
  fieldValue: {
    color: '#111827',
    fontWeight: 500 as const,
  },
  orderActions: {
    display: 'flex',
    gap: 8,
  },
  attachBox: {
    margin: '0 12px 8px',
    padding: 10,
    background: '#EEF2FF',
    border: '1px solid #C7D2FE',
    borderRadius: 8,
  },
  attachTitle: {
    margin: '0 0 4px 0',
    fontSize: 13,
    fontWeight: 600 as const,
    color: '#3730A3',
  },
  attachHint: {
    margin: '0 0 8px 0',
    fontSize: 12,
    lineHeight: 1.6,
    color: '#4338CA',
  },
  attachBtn: {
    display: 'block',
    width: '100%',
    marginBottom: 6,
    padding: '8px 12px',
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left' as const,
  },
  requestBtn: {
    padding: '8px 20px',
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500 as const,
    cursor: 'pointer',
  },
  dismissBtn: {
    padding: '8px 16px',
    background: 'transparent',
    color: '#6B7280',
    border: '1px solid #D1D5DB',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
  },
};
