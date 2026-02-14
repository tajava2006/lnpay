import type { ClaimEvent, OrderRef } from '../types';
import { updateClaimStatus } from '../claim-store';

interface Props {
  claim: ClaimEvent;
  order: OrderRef | undefined;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortenKey(pubkey: string): string {
  return pubkey.slice(0, 8) + '...' + pubkey.slice(-4);
}

export function ClaimCard({ claim, order }: Props) {
  const isPending = claim.status === 'pending';

  return (
    <div style={{
      ...styles.card,
      borderLeft: `4px solid ${statusColor[claim.status]}`,
    }}>
      <div style={styles.top}>
        <div>
          <span style={styles.orderId}>#{claim.orderId}</span>
          {order && (
            <span style={styles.price}>
              {order.price.toLocaleString()}{order.currency === 'KRW' ? '원' : ` ${order.currency}`}
            </span>
          )}
        </div>
        <span style={{
          ...styles.statusBadge,
          background: statusBg[claim.status],
          color: statusColor[claim.status],
        }}>
          {statusLabel[claim.status]}
        </span>
      </div>

      <div style={styles.meta}>
        <span>후원자: {shortenKey(claim.sponsorPubkey)}</span>
        <span>고객: {shortenKey(claim.customerPubkey)}</span>
        <span>{formatDate(claim.createdAt)}</span>
      </div>

      {isPending && (
        <div style={styles.actions}>
          <button
            style={styles.approveBtn}
            onClick={() => updateClaimStatus(claim.id, 'approved')}
          >
            승인
          </button>
          <button
            style={styles.rejectBtn}
            onClick={() => updateClaimStatus(claim.id, 'rejected')}
          >
            거절
          </button>
        </div>
      )}
    </div>
  );
}

const statusLabel: Record<string, string> = {
  pending: '대기',
  approved: '승인',
  rejected: '거절',
};

const statusColor: Record<string, string> = {
  pending: '#D97706',
  approved: '#059669',
  rejected: '#DC2626',
};

const statusBg: Record<string, string> = {
  pending: '#FEF3C7',
  approved: '#D1FAE5',
  rejected: '#FEE2E2',
};

const styles = {
  card: {
    background: '#fff',
    borderRadius: 8,
    padding: '16px 20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  },
  top: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  orderId: {
    fontSize: 15,
    fontWeight: 600 as const,
    color: '#333',
    marginRight: 12,
  },
  price: {
    fontSize: 18,
    fontWeight: 700 as const,
    color: '#4F46E5',
  },
  statusBadge: {
    display: 'inline-block',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 600 as const,
  },
  meta: {
    display: 'flex',
    gap: 16,
    fontSize: 12,
    color: '#999',
    marginBottom: 8,
  },
  actions: {
    display: 'flex',
    gap: 8,
    marginTop: 8,
  },
  approveBtn: {
    background: '#059669',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 20px',
    fontSize: 13,
    fontWeight: 600 as const,
    cursor: 'pointer',
  },
  rejectBtn: {
    background: '#fff',
    color: '#DC2626',
    border: '1px solid #DC2626',
    borderRadius: 6,
    padding: '8px 20px',
    fontSize: 13,
    fontWeight: 600 as const,
    cursor: 'pointer',
  },
};
