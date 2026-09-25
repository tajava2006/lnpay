/**
 * 카드 안의 결제 칸 — 고객 보증금 · 에스크로 · 후원자 보증금이 같은 모양
 *
 * 예전엔 에스크로는 모달, 후원자 보증금은 카드 안 QR, 고객 보증금은 또 모달이었다. 결제하는 사람이
 * 보는 건 셋 다 같다 — 얼마를, 왜, 어떻게. 금액은 인보이스에서 읽는다(오더에 적힌 값이 아니라).
 */
import { useMemo, useSyncExternalStore } from 'react';
import { InvoicePayBlock, type PriceTracker } from '@sajwo-tracker/shared';
import { decodeBolt11 } from '../buyer/bolt11';
import type { PayPurpose } from './card-view';

const FAIR_RATIO_LIMIT = 1.05;

const TITLE: Record<PayPurpose, string> = {
  'customer-deposit': '보증금 결제',
  escrow: '에스크로 결제',
  'sponsor-deposit': '보증금 결제',
};

/** 돌려받는 경우·몰수되는 경우는 데몬의 처리 표(`shared/src/ln/outcomes.ts`)와 같아야 한다 */
const LEAD: Record<PayPurpose, string> = {
  'customer-deposit': '장난 의뢰를 막는 보증금입니다. 내면 의뢰가 오더북에 올라갑니다. 거래가 끝나면 돌려받고, '
    + '후원자가 붙은 뒤 취소하거나, 에스크로를 결제하지 않거나, 계좌 정보를 보내지 않아 기한이 지나면 몰수됩니다.',
  escrow: '결제한 BTC는 거래가 끝날 때까지 에스크로가 맡아둡니다. 원화가 오지 않으면 돌려받습니다. '
    + '지갑에서 "대기 중"으로 남아 있는 것이 정상입니다 — 다시 보내지 마세요.',
  'sponsor-deposit': '공짜 점유를 막는 보증금입니다. 내야 배정이 확정되고, 제한 시간 안에 안 내면 다른 후원자에게 '
    + '넘어갑니다. 인보이스를 등록하지 않고 떠나거나 분쟁에서 지면 몰수되고, 그 밖에는 돌려받습니다.',
};

export function LnPayPanel({ purpose, bolt11, price, tracker }: {
  purpose: PayPurpose;
  bolt11: string;
  /** 의뢰 금액 (KRW) — 시세 대비 비율을 보여준다 */
  price: number;
  tracker: PriceTracker;
}) {
  const btcKrw = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot).price;
  const decoded = useMemo(() => decodeBolt11(bolt11), [bolt11]);
  const expectedSats = btcKrw && price > 0 ? Math.round((price / btcKrw) * 1e8) : null;
  const ratio = decoded && expectedSats ? decoded.amountSat / expectedSats : null;

  return (
    <div style={purpose === 'escrow' ? styles.escrow : styles.deposit}>
      <p style={styles.title}>{TITLE[purpose]}</p>
      {decoded && (
        <div style={styles.amountRow}>
          <b style={styles.amount}>{decoded.amountSat.toLocaleString()} sats</b>
          {ratio !== null && (purpose === 'escrow' ? (
            <span style={{ ...styles.ratio, color: ratio <= FAIR_RATIO_LIMIT ? '#059669' : '#D97706' }}>
              시세 대비 {ratio >= 1 ? '+' : ''}{Math.round((ratio - 1) * 100)}%
            </span>
          ) : (
            <span style={styles.ratio}>의뢰 금액의 약 {Math.round(ratio * 100)}%</span>
          ))}
        </div>
      )}
      <p style={styles.lead}>{LEAD[purpose]}</p>
      <InvoicePayBlock bolt11={bolt11} maxQrSize={200} />
    </div>
  );
}

const styles = {
  escrow: {
    background: '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 8, padding: '12px 14px',
    display: 'flex', flexDirection: 'column' as const, gap: 6,
  },
  deposit: {
    background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '12px 14px',
    display: 'flex', flexDirection: 'column' as const, gap: 6,
  },
  title: { margin: 0, fontSize: 14, fontWeight: 700 as const, color: '#111827' },
  amountRow: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' as const },
  amount: { fontSize: 20, color: '#111827' },
  ratio: { fontSize: 12, color: '#6B7280', fontWeight: 600 as const },
  lead: { margin: 0, fontSize: 12, color: '#4B5563', lineHeight: 1.6 },
};
