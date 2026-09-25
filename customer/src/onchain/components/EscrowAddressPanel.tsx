/**
 * 에스크로 주소 — **내가 직접 검증한 뒤에만** 보여준다 (T-107)
 *
 * ⚠️ 검증에 실패하면 주소를 **아예 보여주지 않는다.** 경고와 함께 주소를 띄우면
 * 누군가는 그걸 복사한다. 어드민이 침해당했을 때 전액을 잃는 자리다.
 */
import { useEffect, useState } from 'react';
import type { OnchainOrder } from '@sajwo-tracker/shared/onchain';
import { myOrderXonly } from '../keys';
import { checkEscrowAddress, type EscrowCheck } from '../verify';

interface Props {
  order: OnchainOrder;
  role: 'customer' | 'sponsor';
}

export function EscrowAddressPanel({ order, role }: Props) {
  const [check, setCheck] = useState<EscrowCheck | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const mine = await myOrderXonly(order.orderId);
      if (alive) setCheck(checkEscrowAddress(order, role, mine));
    })();
    return () => { alive = false; };
  }, [order, role]);

  if (!check) return <p style={styles.checking}>주소를 확인하는 중…</p>;

  if (!check.ok) {
    return (
      <div style={styles.danger}>
        <strong>⚠️ 주소를 신뢰할 수 없습니다</strong>
        <p style={styles.dangerText}>{check.reason}</p>
        <p style={styles.dangerText}>
          이 주문에 <strong>절대 비트코인을 보내지 마세요.</strong> 운영자에게 문의하세요.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.ok}>
      <p style={styles.label}>
        에스크로 주소 <span style={styles.verified}>✓ 내 키로 확인함</span>
      </p>
      <code style={styles.address}>{order.escrowAddress}</code>
      <p style={styles.amount}>
        정확히 <strong>{order.amountSat.toLocaleString()} sats</strong>를 보내세요
      </p>
      <p style={styles.note}>
        이 주소는 앱이 내 키·상대방 키·운영자 키로 <strong>직접 다시 만들어</strong> 대조한 것입니다.
        금액이 다르면 처리되지 않습니다.
      </p>
    </div>
  );
}

const styles = {
  checking: { fontSize: 13, color: '#6B7280', margin: 0 },
  ok: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 12px' },
  danger: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 12px', color: '#991B1B' },
  dangerText: { margin: '6px 0 0', fontSize: 13, lineHeight: 1.5 },
  label: { margin: 0, fontSize: 12, color: '#065F46', fontWeight: 600 as const },
  verified: { marginLeft: 6, fontSize: 11, color: '#059669' },
  address: {
    display: 'block', marginTop: 6, fontSize: 12, wordBreak: 'break-all' as const,
    background: '#fff', border: '1px solid #D1FAE5', borderRadius: 6, padding: '8px 10px',
  },
  amount: { margin: '8px 0 0', fontSize: 14, color: '#065F46' },
  note: { margin: '6px 0 0', fontSize: 11, color: '#6B7280', lineHeight: 1.5 },
};
