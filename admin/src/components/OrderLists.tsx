/**
 * 오더 목록 (PLAN-DAEMON §6)
 *
 * 공개 오더 이벤트를 그대로 보여준다. 줄을 누르면 상세·판정·채팅으로 간다.
 */
import { useSyncExternalStore } from 'react';
import { isTerminalState, stateDisplay } from '@sajwo-tracker/shared';
import { isOnchainTerminal, onchainStateDisplay } from '@sajwo-tracker/shared/onchain';
import { lnOrders, onchainOrders } from '../daemon/stores';

interface Row {
  orderId: string;
  label: string;
  color: string;
  bg: string;
  amount: string;
  updatedAt: number;
  done: boolean;
}

export function LnOrderList({ onSelect }: { onSelect: (orderId: string) => void }) {
  const orders = useSyncExternalStore(lnOrders.subscribe, lnOrders.get);
  const rows: Row[] = Object.values(orders).map(o => {
    const d = stateDisplay(o.state);
    return {
      orderId: o.orderId, label: d.label, color: d.color, bg: d.bg,
      amount: `${o.price.toLocaleString()}원`, updatedAt: o.updatedAt, done: isTerminalState(o.state),
    };
  });
  return <Table title="라이트닝 오더" rows={rows} onSelect={onSelect} />;
}

export function OnchainOrderList({ onSelect }: { onSelect: (orderId: string) => void }) {
  const orders = useSyncExternalStore(onchainOrders.subscribe, onchainOrders.get);
  const rows: Row[] = Object.values(orders).map(o => {
    const d = onchainStateDisplay(o.state);
    return {
      orderId: o.orderId, label: d.label, color: d.color, bg: d.bg,
      amount: `${o.amountSat.toLocaleString()} sats`, updatedAt: o.updatedAt, done: isOnchainTerminal(o.state),
    };
  });
  return <Table title="온체인 오더" rows={rows} onSelect={onSelect} />;
}

function Table({ title, rows, onSelect, note }: {
  title: string; rows: Row[]; onSelect?: (orderId: string) => void; note?: string;
}) {
  const sorted = [...rows].sort((a, b) => Number(a.done) - Number(b.done) || b.updatedAt - a.updatedAt);
  return (
    <section style={styles.card}>
      <h2 style={styles.h2}>{title} <span style={styles.note}>{rows.length}건{note ? ` · ${note}` : ''}</span></h2>
      {rows.length === 0 ? (
        <p style={styles.note}>릴레이에 오더가 없습니다.</p>
      ) : (
        <div style={styles.scroll}>
          <table style={styles.table}>
            <thead>
              <tr><th style={styles.th}>주문</th><th style={styles.th}>상태</th><th style={styles.th}>금액</th><th style={styles.th}>갱신</th></tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr
                  key={r.orderId}
                  style={{ ...(r.done ? styles.doneRow : {}), ...(onSelect ? styles.clickable : {}) }}
                  onClick={onSelect ? () => onSelect(r.orderId) : undefined}
                >
                  <td style={{ ...styles.td, ...styles.mono }}>{r.orderId}</td>
                  <td style={styles.td}><span style={{ ...styles.badge, color: r.color, background: r.bg }}>{r.label}</span></td>
                  <td style={styles.td}>{r.amount}</td>
                  <td style={styles.td}>{new Date(r.updatedAt * 1000).toLocaleString('ko-KR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
  h2: { fontSize: 17, margin: '0 0 12px', color: '#333', display: 'flex', alignItems: 'baseline', gap: 8 },
  note: { fontSize: 12, color: '#6B7280', fontWeight: 400 as const, margin: 0 },
  scroll: { overflowX: 'auto' as const },
  table: { width: '100%', borderCollapse: 'collapse' as const, minWidth: 560 },
  th: { textAlign: 'left' as const, fontSize: 12, color: '#6B7280', padding: '8px 10px', borderBottom: '1px solid #E5E7EB' },
  td: { fontSize: 13, color: '#111827', padding: '10px', borderBottom: '1px solid #F3F4F6' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  badge: { padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600 as const },
  doneRow: { opacity: 0.55 },
  clickable: { cursor: 'pointer' },
};
