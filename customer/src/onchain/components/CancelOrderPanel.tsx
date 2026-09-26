import { useState } from 'react';
import type { OnchainOrder } from '@sajwo-tracker/shared/onchain';
import { publishOnchainCancelRequest } from '../nostr/publish';
import { styles } from './card-styles';

/**
 * 고객: 의뢰를 내린다.
 *
 * **후원자가 붙기 전에만** 보인다. 붙은 뒤에는 상대가 이미 보증금을 걸었으므로
 * 일방 취소가 없다 — 그때부터는 마감과 체인이 판정한다.
 */
export function CancelOrderPanel({ order }: { order: OnchainOrder }) {
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
        아직 아무도 붙지 않았으니 아무도 손해를 보지 않습니다.
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
