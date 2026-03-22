import { useState } from 'react';
import type { Request, Order } from '@sajwo-tracker/shared';
import type { LightningAdapter, ProbeResult } from '../lightning';
import { updateLiquidityVerified } from '../request-store';
import { approveOrder, revertClaim } from '../nostr/service';
import { getSponsorDepositPercent } from '../deposit-config';

interface Props {
  request: Request;
  order: Order | undefined;
  lnAdapter: LightningAdapter | null;
}

const actionLabel: Record<string, string> = {
  'order-request': '주문 요청',
  claim: '클레임',
  'payment-confirm': '결제 확인',
};

const senderLabel: Record<string, string> = {
  'order-request': '고객',
  claim: '후원자',
  'payment-confirm': '고객',
  'cancel-request': '고객',
  'remit-request': '후원자',
  'account-info': '고객',
};

const stateColor: Record<string, string> = {
  requested: '#D97706',
  claimed: '#2563EB',
  verified: '#4F46E5',
  escrowed: '#7C3AED',
  remitted: '#BE185D',
  paid: '#059669',
  cancelled: '#6B7280',
  sponsor_wins: '#0F766E',
  customer_wins: '#0E7490',
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

export function ClaimCard({ request, order, lnAdapter }: Props) {
  const orderState = order?.state;
  const isClaim = request.action === 'claim';
  const invoice = isClaim ? request.invoice : null;
  const decoded = invoice?.decoded ?? null;

  // 승인 가능 조건: 클레임 액션 + LN 어댑터 연결 + 유동성 검증 완료 (상태 판단은 FSM에 위임)
  // 후원자 보증금 설정 시 sponsorDepositPaymentHash가 있어야 승인 가능
  const sponsorDepositRequired = getSponsorDepositPercent() > 0;
  const sponsorDepositPaid = !!order?.sponsorDepositPaymentHash;
  const canApprove = isClaim && !!lnAdapter && (invoice?.liquidityVerified ?? false)
    && (!sponsorDepositRequired || sponsorDepositPaid);

  const [copied, setCopied] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState<{ text: string; color: string } | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);

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

  // 프로브 실패 여부: probeMsg가 실패 색상(빨강/주황)이면 true
  const probeFailed = !!probeMsg && probeMsg.color !== '#059669';

  async function handleRevert() {
    setReverting(true);
    setRevertError(null);
    const result = await revertClaim(request.orderId);
    if (!result.success) {
      setRevertError(result.error ?? '철회 실패');
    }
    setReverting(false);
  }

  async function handleApprove() {
    if (!lnAdapter || !order) return;

    const sponsorSat = decoded?.amountSat;
    if (!sponsorSat) {
      setApproveError('인보이스 금액 없음');
      return;
    }

    setApproving(true);
    setApproveError(null);

    // 후원자의 bolt11 금액 + 0.5% 가산 (paid 시 라우팅 수수료 선취)
    const amountSat = Math.round(sponsorSat * 1.005);
    const result = await approveOrder(request.orderId, lnAdapter, amountSat);
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
        <span style={styles.actionBadge}>
          {actionLabel[request.action] ?? request.action}
        </span>
        <span style={styles.metaText}>
          {senderLabel[request.action] ?? '알 수 없음'} · {formatDate(request.createdAt)}
        </span>
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
              {invoice?.liquidityVerified && !probeMsg && (
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
      ) : invoice && (
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
          {!invoice?.liquidityVerified && (
            <span style={styles.unverifiedHint}>유동성 미검증</span>
          )}
          {sponsorDepositRequired && !sponsorDepositPaid && (
            <span style={styles.unverifiedHint}>후원자 보증금 미납</span>
          )}
          {approveError && (
            <span style={styles.errorHint}>{approveError}</span>
          )}
        </div>
      )}

      {/* 클레임 철회 버튼 (유동성 프로브 실패 시 활성화) */}
      {isClaim && orderState === 'claimed' && probeFailed && (
        <div style={styles.actions}>
          <button
            style={reverting ? styles.revertBtnDisabled : styles.revertBtn}
            onClick={handleRevert}
            disabled={reverting}
          >
            {reverting ? '철회 중...' : '클레임 철회'}
          </button>
          {revertError && (
            <span style={styles.errorHint}>{revertError}</span>
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
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  actionBadge: {
    fontSize: 12,
    fontWeight: 600 as const,
    color: '#4F46E5',
    background: '#EEF2FF',
    borderRadius: 4,
    padding: '2px 8px',
  },
  metaText: {
    fontSize: 12,
    color: '#999',
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
  revertBtn: {
    background: '#D97706',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 20px',
    fontSize: 13,
    fontWeight: 600 as const,
    cursor: 'pointer' as const,
  },
  revertBtnDisabled: {
    background: '#D1D5DB',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 20px',
    fontSize: 13,
    fontWeight: 600 as const,
    cursor: 'not-allowed' as const,
  },
};
