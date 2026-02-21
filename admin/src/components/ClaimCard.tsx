import { useState } from 'react';
import type { ProcessedRequest } from '../types';
import type { PriceTracker, Order } from '@sajwo-tracker/shared';
import type { LightningAdapter, ProbeResult } from '../lightning';
import { updateLiquidityVerified } from '../request-store';
import { approveOrder } from '../nostr/service';
import { SatsAmount } from './SatsAmount';

interface Props {
  request: ProcessedRequest;
  order: Order | undefined;
  tracker: PriceTracker;
  lnAdapter: LightningAdapter | null;
}

const actionLabel: Record<string, string> = {
  'order-request': '주문 요청',
  claim: '클레임',
  'payment-confirm': '결제 확인',
};

const stateLabel: Record<string, string> = {
  requested: '요청됨',
  claimed: '클레임됨',
  verified: '검증됨',
  escrowed: '에스크로',
  paid: '완료',
  cancelled: '취소',
};

const stateColor: Record<string, string> = {
  requested: '#D97706',
  claimed: '#2563EB',
  verified: '#4F46E5',
  escrowed: '#7C3AED',
  paid: '#059669',
  cancelled: '#6B7280',
};

const stateBg: Record<string, string> = {
  requested: '#FEF3C7',
  claimed: '#DBEAFE',
  verified: '#E0E7FF',
  escrowed: '#EDE9FE',
  paid: '#D1FAE5',
  cancelled: '#F3F4F6',
};

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

function probeResultMessage(result: ProbeResult): { text: string; color: string } {
  switch (result.status) {
    case 'reachable':
      return { text: '유동성 확인됨', color: '#059669' };
    case 'unreachable':
      return { text: result.reason, color: '#DC2626' };
    case 'error':
      return { text: result.message, color: '#D97706' };
  }
}

export function ClaimCard({ request, order, tracker, lnAdapter }: Props) {
  const orderState = order?.state;
  const isClaim = request.action === 'claim';
  const decoded = request.invoice?.decoded ?? null;

  // 승인 가능 조건: 클레임 액션 + 유동성 검증 완료 (상태 판단은 FSM에 위임)
  const canApprove = isClaim && (request.invoice?.liquidityVerified ?? false);

  const [copied, setCopied] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState<{ text: string; color: string } | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const copyPubkey = (pubkey: string) => {
    navigator.clipboard.writeText(pubkey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  async function handleProbe() {
    if (!lnAdapter || !decoded) return;
    setProbing(true);
    setProbeMsg(null);
    try {
      const result = await lnAdapter.probe(
        decoded.destination,
        decoded.amountSat,
        undefined,
        decoded.routeHints.length > 0 ? decoded.routeHints : undefined,
      );
      updateLiquidityVerified(request.eventId, result.status === 'reachable');
      setProbeMsg(probeResultMessage(result));
    } catch {
      setProbeMsg({ text: '프로브 요청 실패', color: '#DC2626' });
    } finally {
      setProbing(false);
    }
  }

  async function handleApprove() {
    setApproving(true);
    setApproveError(null);
    const result = await approveOrder(request.orderId);
    if (!result.success) {
      setApproveError(result.error ?? '승인 실패');
    }
    setApproving(false);
  }

  return (
    <div style={{
      ...styles.card,
      borderLeft: `4px solid ${orderState ? (stateColor[orderState] ?? '#999') : '#999'}`,
    }}>
      <div style={styles.top}>
        <div style={styles.topLeft}>
          <span style={styles.actionBadge}>
            {actionLabel[request.action] ?? request.action}
          </span>
          {order && (
            <>
              <span style={styles.price}>
                {order.price.toLocaleString()}원
              </span>
              <SatsAmount krw={order.price} tracker={tracker} />
            </>
          )}
        </div>
        {orderState && (
          <span style={{
            ...styles.statusBadge,
            background: stateBg[orderState] ?? '#F3F4F6',
            color: stateColor[orderState] ?? '#666',
          }}>
            {stateLabel[orderState] ?? orderState}
          </span>
        )}
      </div>

      <div style={styles.meta}>
        <span>
          {isClaim ? '후원자' : '요청자'}: {shortenKey(request.pubkey)}
        </span>
        {order?.customerPubkey && (
          <span>고객: {shortenKey(order.customerPubkey)}</span>
        )}
        <span>{formatDate(request.createdAt)}</span>
      </div>

      {/* 인보이스 디코딩 결과 (클레임만) */}
      {decoded ? (
        <div style={styles.invoiceInfo}>
          <div style={styles.invoiceRow}>
            <span style={styles.invoiceLabel}>노드:</span>
            <span style={styles.invoiceValue}>{shortenKey(decoded.destination)}</span>
            <button
              style={styles.copyBtn}
              onClick={() => copyPubkey(decoded.destination)}
              title="노드 pubkey 복사"
            >
              {copied ? '\u2713' : '\u29C9'}
            </button>
          </div>
          <div style={styles.invoiceRow}>
            <span style={styles.invoiceLabel}>금액:</span>
            <span style={styles.invoiceValue}>
              {decoded.amountSat.toLocaleString()} sats
            </span>
          </div>
          {lnAdapter && (
            <div style={styles.invoiceRow}>
              <button
                style={{
                  ...styles.probeBtn,
                  opacity: probing ? 0.6 : 1,
                  cursor: probing ? 'not-allowed' : 'pointer',
                }}
                onClick={handleProbe}
                disabled={probing}
              >
                {probing ? '검증 중...' : '유동성 검증'}
              </button>
              {request.invoice?.liquidityVerified && !probeMsg && (
                <span style={styles.verifiedBadge}>검증됨</span>
              )}
              {probeMsg && (
                <span style={{ fontSize: 12, fontWeight: 500, color: probeMsg.color }}>
                  {probeMsg.text}
                </span>
              )}
            </div>
          )}
        </div>
      ) : request.invoice && (
        <div style={styles.decodeFailed}>인보이스 디코딩 실패</div>
      )}

      {/* 승인 버튼 (클레임 요청에만 표시) */}
      {isClaim && (
        <div style={styles.actions}>
          <button
            style={canApprove && !approving
              ? styles.approveBtn
              : styles.approveBtnDisabled}
            onClick={handleApprove}
            disabled={!canApprove || approving}
          >
            {approving ? '승인 중...' : '승인'}
          </button>
          {!request.invoice?.liquidityVerified && (
            <span style={styles.unverifiedHint}>유동성 미검증</span>
          )}
          {approveError && (
            <span style={styles.errorHint}>{approveError}</span>
          )}
        </div>
      )}
    </div>
  );
}

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
  topLeft: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
  },
  actionBadge: {
    fontSize: 12,
    fontWeight: 600 as const,
    color: '#4F46E5',
    background: '#EEF2FF',
    borderRadius: 4,
    padding: '2px 8px',
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
  invoiceInfo: {
    background: '#F9FAFB',
    borderRadius: 6,
    padding: '10px 14px',
    marginBottom: 8,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  invoiceRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
  },
  invoiceLabel: {
    color: '#999',
    minWidth: 36,
  },
  invoiceValue: {
    color: '#333',
    fontWeight: 500 as const,
    fontFamily: 'monospace',
  },
  copyBtn: {
    background: 'none',
    border: '1px solid #D1D5DB',
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 13,
    cursor: 'pointer',
    color: '#666',
    fontFamily: 'inherit',
    lineHeight: 1,
  },
  probeBtn: {
    background: '#4F46E5',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600 as const,
    fontFamily: 'inherit',
  },
  verifiedBadge: {
    fontSize: 12,
    fontWeight: 500 as const,
    color: '#059669',
  },
  actions: {
    display: 'flex',
    gap: 8,
    marginTop: 8,
    alignItems: 'center',
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
  approveBtnDisabled: {
    background: '#D1D5DB',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 20px',
    fontSize: 13,
    fontWeight: 600 as const,
    cursor: 'not-allowed',
  },
  unverifiedHint: {
    fontSize: 12,
    color: '#D97706',
    fontWeight: 500 as const,
  },
  errorHint: {
    fontSize: 12,
    color: '#DC2626',
    fontWeight: 500 as const,
  },
  decodeFailed: {
    background: '#FEF2F2',
    borderRadius: 6,
    padding: '8px 14px',
    marginBottom: 8,
    fontSize: 12,
    color: '#DC2626',
    fontWeight: 500 as const,
  },
};
