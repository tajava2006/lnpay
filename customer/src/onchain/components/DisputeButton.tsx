import { useState } from 'react';
import { isPast, krwDeadlineOf, type OnchainOrder } from '@sajwo-tracker/shared/onchain';
import { publishOnchainDispute } from '../nostr/publish';
import { styles } from './card-styles';

/**
 * 분쟁 · 계좌 이의.
 *
 * - `remitted` — 양쪽 다 분쟁을 열 수 있다
 * - `presigned` — **후원자만**, 계좌를 받은 뒤 송금 마감 전에 "계좌를 쓸 수 없다".
 *   상태가 아니라 증거다 — 시계는 멈추지 않고, 마감이 차면 누구 과실인지 운영자가
 *   가른다. 고객에게는 이 단계에 분쟁 버튼이 없다(전에는 떠 있었는데
 *   누르면 어드민이 조용히 버렸다)
 */
export function DisputeButton({ order, role, now }: {
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
    return <p style={styles.warnText}>계좌 이의를 냈습니다. 채팅에 증거(이체 거절 화면 등)를 올려주세요.</p>;
  }
  if (!accountIssue && !remittedDispute) return null;

  return (
    <div style={styles.section}>
      <button
        style={styles.ghost}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void publishOnchainDispute(order.orderId, accountIssue ? 'account-unusable' : 'remitted')
            .finally(() => setBusy(false));
        }}
      >
        {accountIssue ? '계좌에 문제가 있어요' : '문제가 있습니다 (분쟁)'}
      </button>
    </div>
  );
}
