/**
 * 오더북 카드 — **남의 의뢰만** 그린다 (클레임할 수 있는 것 · 다른 후원자가 진행 중인 것)
 *
 * 내가 참여한 의뢰(내가 사주는 것 · 내가 올린 것)는 여기서 그리지 않는다 — 어느 탭에서든 같은
 * `LnOrderCard`다(2026-09-24). 예전엔 이 카드가 내 거래의 보증금·인보이스·송금까지 들고 있어서, 같은
 * 의뢰를 탭마다 다른 버튼으로 보게 됐다.
 */
import { useState } from 'react';
import { guarded, lnOrderDisplay, remainingText, sponsorRelation, type Order } from '@sajwo-tracker/shared';
import { publishClaim } from '../nostr/claim';
import { ui } from '../../ui';

interface Props {
  order: Order;
  now: number;
  /** 내 pubkey. 아직 로딩 중이면 null — 남의 거래로 단정하지 않는다 */
  myPubkey: string | null;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('ko-KR', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export const OrderCard = guarded(OrderCardBody, '오더북 카드');

function OrderCardBody({ order, now, myPubkey }: Props) {
  const [claiming, setClaiming] = useState(false);
  const relation = sponsorRelation(order, myPubkey);
  const isTaken = relation === 'taken';
  const badge = lnOrderDisplay(order);
  const isUrgent = order.expiration > 0 && order.expiration - now < 3600;

  async function handleClaim() {
    setClaiming(true);
    try {
      if (!(await publishClaim(order))) alert('클레임 발행에 실패했습니다.');
    } catch (err) {
      console.error('[Claim] Error:', err);
      alert('클레임 발행 중 오류가 발생했습니다.');
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div style={isTaken ? { ...styles.card, ...styles.cardTaken } : styles.card}>
      <div style={styles.top}>
        <span style={ui.price}>{order.price.toLocaleString()}원</span>
        <span style={{ ...ui.timeLeft, color: isUrgent ? '#DC2626' : '#666' }}>
          {order.expiration === 0 ? '기한 없음' : remainingText(order.expiration - now, '기한 지남')}
        </span>
      </div>

      <div style={styles.middle}>
        {relation === 'open' ? (
          <>
            {/* 클레임은 버튼 하나다. 인보이스는 에스크로가 잡힌 뒤에 낸다 */}
            <button
              style={{ ...styles.claimBtn, opacity: claiming ? 0.5 : 1, cursor: claiming ? 'not-allowed' : 'pointer' }}
              onClick={() => void handleClaim()}
              disabled={claiming}
            >
              {claiming ? '발행 중...' : '사줄게'}
            </button>
            <p style={styles.hint}>
              맡겠다는 표시만 합니다. 보증금이 요구되면 그걸 내야 배정이 확정되고, 고객이 결제를 마치면 BTC 받을
              인보이스를 등록하게 됩니다.
            </p>
          </>
        ) : (
          <div style={ui.statusRow}>
            <span style={{ ...styles.statusBadge, background: badge.bg, color: badge.color }}>{badge.label}</span>
            {isTaken && <span style={styles.lockBadge}>다른 후원자가 진행 중</span>}
          </div>
        )}
        {isTaken && (
          <p style={styles.takenNotice}>
            이미 다른 후원자가 가져간 의뢰라 참여할 수 없습니다.
            거래가 취소되거나 보증금을 안 내 풀리면 다시 '요청됨'으로 돌아오고, 그때는 누구나 참여할 수 있습니다.
          </p>
        )}
      </div>

      <div style={styles.bottom}>
        <span style={styles.meta}>#{order.orderId}</span>
        <span style={styles.meta}>{order.expiration > 0 ? formatDate(order.expiration) : ''}</span>
      </div>
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 10, padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
  cardTaken: {
    // 손댈 수 없는 주문임을 한눈에. 정보는 계속 읽히게 과하지 않은 수준으로.
    background: '#FAFAFA', opacity: 0.72, boxShadow: 'none', border: '1px dashed #D1D5DB',
  },
  top: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  middle: { marginBottom: 8, display: 'flex', flexDirection: 'column' as const, gap: 8 },
  claimBtn: {
    alignSelf: 'flex-start' as const, background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 6,
    padding: '8px 16px', fontSize: 14, fontWeight: 600 as const,
  },
  hint: { fontSize: 12, color: '#888', margin: 0, lineHeight: 1.5 },
  statusBadge: { display: 'inline-block', borderRadius: 6, padding: '6px 12px', fontSize: 13, fontWeight: 500 as const },
  lockBadge: {
    display: 'inline-block', padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600 as const,
    background: '#F3F4F6', color: '#4B5563', border: '1px solid #E5E7EB',
  },
  takenNotice: { margin: 0, fontSize: 12, lineHeight: 1.6, color: '#6B7280' },
  bottom: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  meta: { fontSize: 12, color: '#999' },
};
