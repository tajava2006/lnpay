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
      const result = checkEscrowAddress(order, role, mine);
      if (!result.ok) console.warn('[온체인] 에스크로 주소 검증 실패', order.orderId, result.reason);
      if (alive) setCheck(result);
    })();
    return () => { alive = false; };
  }, [order, role]);

  if (!check) return <p style={styles.checking}>주소를 확인하는 중…</p>;

  // 검증은 앱이 알아서 한다 — 어떻게 검증하는지는 유저가 알 필요가 없고, 문구로 안전함을 알 수도 없다(2026-10-22 운영자).
  // 실패하면 "보내지 마세요"만 말하고 기술적 사유는 콘솔에(위 effect)
  if (!check.ok) {
    return (
      <div style={styles.danger}>
        <strong>⚠️ 이 주문에는 비트코인을 보내지 마세요</strong>
        <p style={styles.dangerText}>주소 확인에 실패했습니다. 운영자에게 문의하세요.</p>
      </div>
    );
  }

  return (
    <div style={styles.ok}>
      <p style={styles.label}>에스크로 주소</p>
      <code style={styles.address}>{order.escrowAddress}</code>
      <p style={styles.amount}>
        정확히 <strong>{order.amountSat.toLocaleString()} sats</strong>를 보내세요
      </p>
      <p style={styles.note}>금액이 다르면 처리되지 않습니다.</p>
    </div>
  );
}

const styles = {
  checking: { fontSize: 13, color: '#6B7280', margin: 0 },
  ok: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 12px' },
  danger: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 12px', color: '#991B1B' },
  dangerText: { margin: '6px 0 0', fontSize: 13, lineHeight: 1.5 },
  label: { margin: 0, fontSize: 12, color: '#065F46', fontWeight: 600 as const },
  address: {
    display: 'block', marginTop: 6, fontSize: 12, wordBreak: 'break-all' as const,
    background: '#fff', border: '1px solid #D1FAE5', borderRadius: 6, padding: '8px 10px',
  },
  amount: { margin: '8px 0 0', fontSize: 14, color: '#065F46' },
  note: { margin: '6px 0 0', fontSize: 11, color: '#6B7280', lineHeight: 1.5 },
};
