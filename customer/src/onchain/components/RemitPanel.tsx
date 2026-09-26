import { useEffect, useState, useSyncExternalStore } from 'react';
import { BUTTON } from '@sajwo-tracker/shared';
import {
  MempoolChainAdapter, isPast, krwDeadlineOf, type AddressFunds, type ChainQuery, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { getOnchainAccountsSnapshot, subscribeOnchainAccounts } from '../account-store';
import { timelockStatus } from '../actions';
import { checkFundingOnChain } from '../verify';
import { publishRemitRequestOnchain } from '../nostr/remit';
import { styles } from './card-styles';

function chainFor(order: OnchainOrder): MempoolChainAdapter {
  return new MempoolChainAdapter({
    network: order.network === 'mainnet' ? 'mainnet' : order.network === 'testnet' ? 'testnet' : 'signet',
  });
}

/**
 * 후원자: 원화 송금.
 *
 * 버튼은 **넷이 다 맞을 때만** 열린다:
 *   - 운영자가 **고객이 계좌를 보냈다고 확인**했다(`accountSentAt`) — 계좌 스토어에
 *     뭔가 있다는 것만으로는 부족하다
 *   - 송금 마감 전이다 — 지나면 어드민이 받지 않고 환불로 간다
 *   - **펀딩이 체인에 약정 금액으로 있다** — 내가 직접 본다
 *   - 타임락 잔여가 충분하다(T-106)
 */
export function RemitPanel({ order, now }: { order: OnchainOrder; now: number }) {
  const [funds, setFunds] = useState<ChainQuery<AddressFunds> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const accounts = useSyncExternalStore(subscribeOnchainAccounts, getOnchainAccountsSnapshot);
  const account = order.accountSentAt ? accounts[order.orderId] : undefined;

  useEffect(() => {
    let alive = true;
    if (!order.escrowAddress) return;
    void chainFor(order).getAddressFunds(order.escrowAddress).then(r => { if (alive) setFunds(r); });
    return () => { alive = false; };
  }, [order]);

  const funding = checkFundingOnChain(order, funds);
  const status = timelockStatus(order, funding.ok ? funding.confirmations : undefined);
  const deadlinePassed = order.accountSentAt !== undefined && isPast(krwDeadlineOf(order), now);
  const canRemit = Boolean(account) && funding.ok && status.safeToRemit && !deadlinePassed;

  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>원화 송금</p>

      {account ? (
        <div style={styles.account}>
          <p style={styles.accountLine}>
            <strong>{account.accountInfo.bankName}</strong> {account.accountInfo.accountNumber}
          </p>
          <p style={styles.accountLine}>예금주 {account.accountInfo.holderName}</p>
          {order.priceKrw !== undefined && (
            <p style={styles.accountAmount}>
              보낼 금액 <strong>{order.priceKrw.toLocaleString()}원</strong>
            </p>
          )}
        </div>
      ) : (
        <p style={styles.warnText}>
          {order.accountSentAt
            ? '계좌 정보를 아직 받지 못했습니다. 잠시 후 다시 보세요.'
            : '상대방이 계좌를 보내기를 기다리는 중입니다.'}
        </p>
      )}

      <p style={funding.ok ? styles.okText : styles.warnText}>
        {funding.ok ? `에스크로에 비트코인이 들어와 있습니다 (${funding.confirmations} 컨펌)` : funding.reason}
      </p>
      {/* 타임락은 막힐 때만 말한다 — 여유가 있을 때 블록 수를 보여주면 읽는 사람만 헷갈린다(2026-09-25) */}
      {!status.safeToRemit && <p style={styles.warnText}>{status.reason}</p>}
      {deadlinePassed && (
        <p style={styles.dangerText}>송금 마감이 지났습니다. <strong>원화를 보내지 마세요</strong> — 거래가 환불로 넘어갑니다.</p>
      )}
      <button
        style={canRemit ? styles.primary : styles.disabled}
        disabled={!canRemit || busy || sent}
        onClick={() => {
          setBusy(true);
          void publishRemitRequestOnchain(order.orderId)
            .then(() => setSent(true))
            .finally(() => setBusy(false));
        }}
      >
        {sent ? '송금 완료를 알렸습니다' : busy ? '보내는 중…' : BUTTON.remitted}
      </button>
    </div>
  );
}
