/**
 * 온체인 트랙 패널 (PLAN-ONCHAIN-TRACK §9)
 *
 * 어드민이 **분쟁 때만** 손대면 되게 만드는 화면이다. 그래서 여기 있는 건 셋뿐:
 *   ① **경보** — 자동 진행도 자동 취소도 위험해 멈춰 선 것들. 사람이 안 오면 안 끝난다
 *   ② **서명 대기** — 상대가 서명해야 종결되는 것들 (재촉/재전송)
 *   ③ **분쟁 판정** — 유일하게 판단이 필요한 자리
 *
 * ⚠️ 판정 버튼 옆에 §7.7을 그대로 적어둔다. **어드민은 애매한 순간에 이 화면을
 * 본다** — 거기 적힌 기본값이 곧 실제 판정이 된다.
 */
import { useSyncExternalStore } from 'react';
import { onchainStateDisplay } from '@sajwo-tracker/shared/onchain';
import {
  clearOnchainAlert, getOnchainAlertsSnapshot, subscribeOnchainAlerts,
} from '../onchain/alert-store';
import { getSnapshot, subscribe } from '../onchain/order-store';
import {
  getPendingSettlementsSnapshot, subscribePendingSettlements,
} from '../onchain/pending-settlement-store';
import { prepareOnchainSettlement } from '../onchain/service';

export function OnchainPanel() {
  const orders = useSyncExternalStore(subscribe, getSnapshot);
  const alerts = useSyncExternalStore(subscribeOnchainAlerts, getOnchainAlertsSnapshot);
  // ⚠️ 스냅샷은 **참조가 안정해야 한다.** `Object.values()`를 여기서 부르면
  // 매 렌더마다 새 배열이라 React가 무한 루프를 돈다. 목록은 아래에서 만든다.
  const pendingMap = useSyncExternalStore(
    subscribePendingSettlements, getPendingSettlementsSnapshot,
  );

  const pending = Object.values(pendingMap);
  const list = Object.values(orders).filter(o => o.status === 'active');
  const disputes = list.filter(o => o.state === 'disputed');
  const alertList = Object.values(alerts).sort((a, b) =>
    a.level === b.level ? b.at - a.at : a.level === 'anomaly' ? -1 : 1);

  return (
    <section style={styles.panel}>
      <h2 style={styles.heading}>온체인 트랙</h2>

      {alertList.length > 0 && (
        <div style={styles.block}>
          <p style={styles.blockTitle}>경보</p>
          {alertList.map(alert => (
            <div
              key={alert.orderId}
              style={alert.level === 'anomaly' ? styles.anomaly : styles.warn}
            >
              <div>
                <strong>{alert.orderId}</strong>
                <p style={styles.why}>{alert.why}</p>
              </div>
              <button style={styles.ghost} onClick={() => clearOnchainAlert(alert.orderId)}>
                확인함
              </button>
            </div>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div style={styles.block}>
          <p style={styles.blockTitle}>서명 대기</p>
          {pending.map(p => (
            <div key={p.orderId} style={styles.row}>
              <strong>{p.orderId}</strong>
              <span style={styles.meta}>{p.settlementKind}</span>
              <span style={styles.meta}>
                {p.awaiting === 'customer' ? '고객' : '후원자'} 서명 대기
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={styles.block}>
        <p style={styles.blockTitle}>진행 중 ({list.length})</p>
        {list.length === 0 && <p style={styles.empty}>없음</p>}
        {list.map(order => {
          const badge = onchainStateDisplay(order.state);
          return (
            <div key={order.orderId} style={styles.row}>
              <span style={{ ...styles.badge, color: badge.color, background: badge.bg }}>
                {badge.label}
              </span>
              <strong>{order.orderId}</strong>
              <span style={styles.meta}>{order.amountSat.toLocaleString()} sats</span>
              {order.priceKrw !== undefined && (
                <span style={styles.meta}>{order.priceKrw.toLocaleString()}원</span>
              )}
            </div>
          );
        })}
      </div>

      {disputes.length > 0 && (
        <div style={styles.block}>
          <p style={styles.blockTitle}>분쟁 판정 ({disputes.length})</p>
          <div style={styles.guide}>
            <strong>기본 승자는 없다.</strong> 오판의 비용이 양쪽 같다 — 잘못된
            후원자승은 고객이 원화 없이 BTC를 잃고, 잘못된 고객승은 후원자가
            원화를 내고 BTC를 못 받는다.
            <ol style={styles.guideList}>
              <li><strong>자금을 움직여 달라는 쪽이 먼저 증명한다</strong> (후원자).</li>
              <li>금액·수취인명·시각이 맞는 이체 내역이면 책임이 고객에게 넘어간다.</li>
              <li><strong>증거 제출을 거부하는 쪽에 불리하게</strong> 본다. 침묵은 패소가 아니다.</li>
              <li>정면 충돌이면 은행 기록을 정밀 대조하고, 안 갈리면 보류 후 에스컬레이션.</li>
            </ol>
            중재료는 <strong>패소자의 몰수 보증금에서</strong> 나간다 — 분쟁 tx에 출력을 달지 않는다.
          </div>

          {disputes.map(order => (
            <div key={order.orderId} style={styles.row}>
              <strong>{order.orderId}</strong>
              <button
                style={styles.decide}
                onClick={() => void prepareOnchainSettlement(order, 'sponsor_win')}
              >
                후원자 승
              </button>
              <button
                style={styles.decide}
                onClick={() => void prepareOnchainSettlement(order, 'customer_win')}
              >
                고객 승
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const styles = {
  panel: { border: '1px solid #E5E7EB', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column' as const, gap: 14 },
  heading: { margin: 0, fontSize: 16 },
  block: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  blockTitle: { margin: 0, fontSize: 13, fontWeight: 600 as const, color: '#374151' },
  empty: { margin: 0, fontSize: 13, color: '#9CA3AF' },
  row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '6px 0', borderBottom: '1px solid #F3F4F6' },
  meta: { fontSize: 12, color: '#6B7280' },
  badge: { fontSize: 11, fontWeight: 600 as const, padding: '2px 6px', borderRadius: 4 },
  anomaly: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 10px', color: '#991B1B' },
  warn: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '8px 10px', color: '#9A3412' },
  why: { margin: '2px 0 0', fontSize: 12, lineHeight: 1.5 },
  ghost: { padding: '5px 10px', fontSize: 12, background: '#fff', border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer' },
  decide: { padding: '6px 12px', fontSize: 12, fontWeight: 600 as const, background: '#111827', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' },
  guide: { background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#374151', lineHeight: 1.7 },
  guideList: { margin: '6px 0', paddingLeft: 18, display: 'flex', flexDirection: 'column' as const, gap: 3 },
};
