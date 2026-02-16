import { useState } from 'react';
import type { ClaimEvent, OrderRef } from '../types';
import type { PriceTracker } from '@sajwo-tracker/shared';
import type { LightningAdapter, ProbeResult } from '../lightning';
import { updateClaimStatus, updateLiquidityVerified } from '../claim-store';
import { SatsAmount } from './SatsAmount';

interface Props {
  claim: ClaimEvent;
  order: OrderRef | undefined;
  tracker: PriceTracker;
  lnAdapter: LightningAdapter | null;
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

export function ClaimCard({ claim, order, tracker, lnAdapter }: Props) {
  const isPending = claim.status === 'pending';
  const canApprove = isPending && (claim.invoice?.liquidityVerified ?? false);
  const decoded = claim.invoice?.decoded ?? null;

  const [copied, setCopied] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState<{ text: string; color: string } | null>(null);

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
      updateLiquidityVerified(claim.id, result.status === 'reachable');
      setProbeMsg(probeResultMessage(result));
    } catch (e) {
      setProbeMsg({ text: '프로브 요청 실패', color: '#DC2626' });
    } finally {
      setProbing(false);
    }
  }

  return (
    <div style={{
      ...styles.card,
      borderLeft: `4px solid ${statusColor[claim.status]}`,
    }}>
      <div style={styles.top}>
        <div style={styles.topLeft}>
          <span style={styles.orderId}>#{claim.orderId}</span>
          {order && (
            <>
              <span style={styles.price}>
                {order.price.toLocaleString()}{order.currency === 'KRW' ? '원' : ` ${order.currency}`}
              </span>
              {order.currency === 'KRW' && (
                <SatsAmount krw={order.price} tracker={tracker} />
              )}
            </>
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

      {/* 인보이스 디코딩 결과 */}
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
              {copied ? '✓' : '⧉'}
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
              {claim.invoice?.liquidityVerified && !probeMsg && (
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
      ) : claim.invoice && (
        <div style={styles.decodeFailed}>인보이스 디코딩 실패</div>
      )}

      {isPending && (
        <div style={styles.actions}>
          <button
            style={canApprove ? styles.approveBtn : styles.approveBtnDisabled}
            onClick={() => updateClaimStatus(claim.id, 'approved')}
            disabled={!canApprove}
          >
            승인
          </button>
          <button
            style={styles.rejectBtn}
            onClick={() => updateClaimStatus(claim.id, 'rejected')}
          >
            거절
          </button>
          {claim.invoice && !claim.invoice.liquidityVerified && (
            <span style={styles.unverifiedHint}>유동성 미검증</span>
          )}
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
  topLeft: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
  },
  orderId: {
    fontSize: 15,
    fontWeight: 600 as const,
    color: '#333',
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
  unverifiedHint: {
    fontSize: 12,
    color: '#D97706',
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
