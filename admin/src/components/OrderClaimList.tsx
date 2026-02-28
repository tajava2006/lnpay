import { useState, useSyncExternalStore } from 'react';
import {
  subscribe as requestSubscribe,
  getSnapshot as requestSnapshot,
} from '../request-store';
import {
  subscribe as orderSubscribe,
  getSnapshot as orderSnapshot,
} from '../order-store';
import type { PriceTracker } from '@sajwo-tracker/shared';
import type { LightningAdapter } from '../lightning';
import type { ProcessedRequest } from '../types';
import { disburseSponsor } from '../nostr/service';
import { ClaimCard } from './ClaimCard';
import { SatsAmount } from './SatsAmount';

interface Props {
  orderId: string;
  onBack: () => void;
  tracker: PriceTracker;
  lnAdapter: LightningAdapter | null;
}

const stateLabel: Record<string, string> = {
  requested: '요청됨',
  claimed: '클레임됨',
  verified: '검증됨',
  escrowed: '에스크로',
  remitted: '송금 주장',
  paid: '완료',
  cancelled: '취소',
  sponsor_wins: '후원자 승리',
  customer_wins: '고객 승리',
};

const DISBURSE_STATES = new Set(['paid', 'sponsor_wins']);

export function OrderClaimList({ orderId, onBack, tracker, lnAdapter }: Props) {
  const requests = useSyncExternalStore(requestSubscribe, requestSnapshot);
  const orders = useSyncExternalStore(orderSubscribe, orderSnapshot);

  const order = orders[orderId];
  const showDisburse = order && DISBURSE_STATES.has(order.state);

  const [disbursing, setDisbursing] = useState(false);
  const [disburseError, setDisburseError] = useState<string | null>(null);

  async function handleDisburse() {
    setDisbursing(true);
    setDisburseError(null);
    const result = await disburseSponsor(orderId);
    if (!result.success) {
      setDisburseError(result.error ?? '송금 실패');
    }
    setDisbursing(false);
  }

  // 해당 주문의 요청만 필터 + 정렬 (최신순)
  const requestList = Object.values(requests)
    .filter((r): r is ProcessedRequest => r.orderId === orderId)
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div>
      <button style={styles.backBtn} onClick={onBack}>
        ← 오더 목록
      </button>

      <div style={styles.orderHeader}>
        <div style={styles.orderTop}>
          <span style={styles.orderId}>#{orderId}</span>
          {order && (
            <>
              <span style={styles.price}>
                {order.price.toLocaleString()}원
              </span>
              <SatsAmount krw={order.price} tracker={tracker} />
            </>
          )}
        </div>
        <div style={styles.orderMeta}>
          {order && (
            <span style={styles.stateBadge}>
              {stateLabel[order.state] ?? order.state}
            </span>
          )}
          {order?.expiration != null && order.expiration > 0 && (
            <span>
              만료: {new Date(order.expiration * 1000).toLocaleString('ko-KR', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </span>
          )}
        </div>

        {/* 송금 상태 (paid / sponsor_wins) */}
        {showDisburse && (
          <div style={styles.disburseRow}>
            {order.disbursed ? (
              <span style={styles.disbursedBadge}>송금 완료</span>
            ) : (
              <>
                <span style={styles.undisbursedBadge}>미송금</span>
                <button
                  style={disbursing ? styles.disburseBtnDisabled : styles.disburseBtn}
                  onClick={handleDisburse}
                  disabled={disbursing}
                >
                  {disbursing ? '송금 중...' : '수동 송금'}
                </button>
                {disburseError && (
                  <span style={styles.disburseError}>{disburseError}</span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div style={styles.stats}>
        요청 {requestList.length}건
      </div>

      {requestList.length === 0 ? (
        <div style={styles.empty}>이 오더에 대한 요청이 없습니다</div>
      ) : (
        <div style={styles.list}>
          {requestList.map(request => (
            <ClaimCard
              key={request.eventId}
              request={request}
              order={order}
              tracker={tracker}
              lnAdapter={lnAdapter}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#4F46E5',
    fontSize: 14,
    cursor: 'pointer',
    padding: '4px 0',
    marginBottom: 16,
    fontFamily: 'inherit',
  },
  orderHeader: {
    background: '#F9FAFB',
    borderRadius: 8,
    padding: '16px 20px',
    marginBottom: 16,
  },
  orderTop: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
  },
  orderId: {
    fontSize: 18,
    fontWeight: 600 as const,
    color: '#333',
  },
  price: {
    fontSize: 22,
    fontWeight: 700 as const,
    color: '#4F46E5',
  },
  orderMeta: {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    fontSize: 12,
    color: '#999',
    marginTop: 6,
  },
  stateBadge: {
    background: '#E0E7FF',
    color: '#4F46E5',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 600 as const,
  },
  stats: {
    fontSize: 13,
    color: '#666',
    marginBottom: 12,
  },
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  empty: {
    textAlign: 'center' as const,
    padding: 48,
    color: '#666',
    fontSize: 14,
  },
  disburseRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  disbursedBadge: {
    fontSize: 12,
    fontWeight: 600 as const,
    color: '#059669',
    background: '#D1FAE5',
    borderRadius: 4,
    padding: '2px 8px',
  },
  undisbursedBadge: {
    fontSize: 12,
    fontWeight: 600 as const,
    color: '#DC2626',
    background: '#FEF2F2',
    borderRadius: 4,
    padding: '2px 8px',
  },
  disburseBtn: {
    background: '#4F46E5',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600 as const,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
  },
  disburseBtnDisabled: {
    background: '#D1D5DB',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600 as const,
    cursor: 'not-allowed' as const,
    fontFamily: 'inherit',
  },
  disburseError: {
    fontSize: 12,
    color: '#DC2626',
    fontWeight: 500 as const,
  },
};
