import type { SajwoRequest } from '../types';

interface Props {
  request: SajwoRequest;
  now: number;
}

function formatTimeLeft(expiresAt: number | null, now: number): string {
  if (!expiresAt) return '기한 없음';

  const diff = expiresAt - now;

  if (diff <= 0) return '만료됨';

  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;

  if (hours > 0) {
    return `${hours}시간 ${minutes}분 남음`;
  }
  if (minutes > 0) {
    return `${minutes}분 ${seconds}초 남음`;
  }
  return `${seconds}초 남음`;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function OrderCard({ request, now }: Props) {
  const timeLeft = formatTimeLeft(request.expiresAt, now);
  const isUrgent = request.expiresAt
    ? request.expiresAt - now < 3600
    : false;

  return (
    <div style={styles.card}>
      <div style={styles.top}>
        <span style={styles.price}>
          {request.price.toLocaleString()}{request.currency === 'KRW' ? '원' : ` ${request.currency}`}
        </span>
        <span style={{
          ...styles.timeLeft,
          color: isUrgent ? '#DC2626' : '#666',
        }}>
          {timeLeft}
        </span>
      </div>
      <div style={styles.bottom}>
        <span style={styles.meta}>#{request.orderId}</span>
        <span style={styles.meta}>{request.expiresAt ? formatDate(request.expiresAt) : ''}</span>
      </div>
    </div>
  );
}

const styles = {
  card: {
    background: '#fff',
    borderRadius: 10,
    padding: '16px 20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  },
  top: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  price: {
    fontSize: 20,
    fontWeight: 600 as const,
    color: '#4F46E5',
  },
  timeLeft: {
    fontSize: 13,
    fontWeight: 500 as const,
  },
  bottom: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  meta: {
    fontSize: 12,
    color: '#999',
  },
};
