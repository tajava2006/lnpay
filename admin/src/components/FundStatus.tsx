/**
 * 자금 현황 — 이 거래에 묶인 돈이 지금 어디 있는가
 *
 * ── 왜 필요한가
 *
 * 강제 종결은 홀드 인보이스를 취소하는 동작이다. **뭘 취소하는지 모르고 누르면
 * 안 된다.** 이미 정산된 걸 취소하려 들거나, 아직 안 받은 걸 받은 줄 알고
 * 판단하면 남의 돈이 잘못된다.
 *
 * 이 거래에 묶일 수 있는 돈은 셋이다:
 *
 *   고객 보증금    스팸 방어용 선납 (지금은 꺼져 있어 대개 없음)
 *   후원자 보증금  트롤 방어용 선납 (마찬가지)
 *   에스크로       실제 거래 금액 — 제일 중요하다
 *
 * ── 표시
 *
 *   ○  없음 / 미결제 — 아직 우리 것이 아니다
 *   ◐  accepted — **받았지만 아직 정산 안 됨.** 취소하면 상대에게 돌아간다
 *   ●  settled — 정산 완료. 우리 것이고, 되돌리려면 별도 결제가 필요하다
 *   ✕  cancelled — 이미 환불됨
 *
 * ◐와 ●의 차이가 핵심이다. ◐는 취소로 되돌릴 수 있지만 ●는 못 되돌린다.
 */
import { useEffect, useState } from 'react';
import type { Order } from '@sajwo-tracker/shared';
import type { LightningAdapter, HoldInvoiceStatus } from '../lightning';
import { getEscrowEntry } from '../escrow-store';

type Cell = { label: string; status: HoldInvoiceStatus | 'none' | 'error' };

const MARK: Record<Cell['status'], { icon: string; text: string; color: string }> = {
  none: { icon: '○', text: '없음', color: '#9CA3AF' },
  open: { icon: '○', text: '미결제', color: '#9CA3AF' },
  accepted: { icon: '◐', text: '받음 (미정산)', color: '#D97706' },
  settled: { icon: '●', text: '정산됨', color: '#059669' },
  cancelled: { icon: '✕', text: '환불됨', color: '#6B7280' },
  error: { icon: '?', text: '조회 실패', color: '#DC2626' },
};

export function FundStatus({ order, lnAdapter }: { order: Order; lnAdapter: LightningAdapter | null }) {
  const [cells, setCells] = useState<Cell[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function look(label: string, hash: string | undefined): Promise<Cell> {
      if (!hash) return { label, status: 'none' };
      if (!lnAdapter) return { label, status: 'error' };
      try {
        return { label, status: await lnAdapter.lookupHoldInvoice(hash) };
      } catch {
        // 조회 실패를 'none'으로 뭉개면 "없다"로 읽혀 위험한 판단을 부른다.
        return { label, status: 'error' };
      }
    }

    void (async () => {
      const escrow = getEscrowEntry(order.orderId);
      const result = await Promise.all([
        look('에스크로', escrow?.paymentHash),
        look('고객 보증금', order.depositPaymentHash),
        look('후원자 보증금', order.sponsorDepositPaymentHash),
      ]);
      if (!cancelled) setCells(result);
    })();

    return () => { cancelled = true; };
  }, [order.orderId, order.depositPaymentHash, order.sponsorDepositPaymentHash, lnAdapter]);

  if (!cells) return <p style={styles.loading}>자금 현황 확인 중…</p>;

  return (
    <div style={styles.box}>
      <p style={styles.title}>자금 현황</p>
      {cells.map(c => {
        const m = MARK[c.status];
        return (
          <div key={c.label} style={styles.row}>
            <span style={{ ...styles.icon, color: m.color }}>{m.icon}</span>
            <span style={styles.label}>{c.label}</span>
            <span style={{ ...styles.status, color: m.color }}>{m.text}</span>
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  box: {
    padding: 12,
    background: '#F9FAFB',
    border: '1px solid #E5E7EB',
    borderRadius: 8,
    marginBottom: 12,
  },
  title: { margin: '0 0 8px 0', fontSize: 13, fontWeight: 600 as const, color: '#374151' },
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' },
  icon: { fontSize: 15, width: 16, textAlign: 'center' as const },
  label: { fontSize: 13, color: '#4B5563', minWidth: 90 },
  status: { fontSize: 12 },
  loading: { fontSize: 12, color: '#9CA3AF' },
};
