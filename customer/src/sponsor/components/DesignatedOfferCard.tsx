/**
 * 나를 지정한 라이트닝 의뢰 하나 — 고객 확인 코드 대조 + 위험 고지 → [수락] (docs/PLAN-DESIGNATED-TRADE.md §8)
 *
 * 수락은 공개 의뢰의 "사줄게"와 같은 클레임이다. 데몬이 지정된 사람인지 보고, **보증금 없이 바로 승인**한다 —
 * 그래서 누르면 곧 고객 결제 단계로 넘어가고 이 카드는 "내가 사주는 중"으로 옮겨 간다.
 */
import { useState } from 'react';
import { checkCode, guarded, remainingText, type Order } from '@sajwo-tracker/shared';
import { DesignatedConsent, NO_CONSENT, consentGiven, type Consent } from '../../designated/components';
import { publishClaim } from '../nostr/claim';
import { ui } from '../../ui';

export const DesignatedOfferCard = guarded(DesignatedOfferCardBody, '지정 거래 카드');

function DesignatedOfferCardBody({ order, now }: { order: Order; now: number }) {
  const [consent, setConsent] = useState<Consent>(NO_CONSENT);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function accept() {
    setSending(true);
    try {
      if (await publishClaim(order)) setSent(true);
      else alert('수락을 보내지 못했습니다. 다시 시도해 주세요.');
    } catch (err) {
      console.error('[지정 거래] 수락 실패:', err);
      alert('수락을 보내지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={styles.card}>
      <div style={styles.top}>
        <span style={ui.price}>{order.price.toLocaleString()}원</span>
        <span style={{ ...ui.timeLeft, color: order.expiration - now < 3600 ? '#DC2626' : '#6B7280' }}>
          {remainingText(order.expiration - now, '기한 지남')}
        </span>
      </div>
      <p style={styles.lead}>
        고객이 나를 상대로 지정한 의뢰입니다. 수락하면 바로 내가 맡고, 고객이 결제하면 BTC 받을 인보이스를 등록하게 됩니다.
      </p>
      {sent ? (
        <p style={styles.sent}><span className="spinner" /> 수락을 보냈습니다 — 확인되면 "내가 사주는 중"으로 옮겨 갑니다.</p>
      ) : (
        <>
          <DesignatedConsent track="ln" code={checkCode(order.customerPubkey)} who="고객" value={consent} onChange={setConsent} />
          <button
            type="button"
            style={{ ...styles.accept, opacity: consentGiven(consent) && !sending ? 1 : 0.5 }}
            disabled={!consentGiven(consent) || sending}
            onClick={() => void accept()}
          >
            {sending ? '보내는 중...' : '수락'}
          </button>
        </>
      )}
      <span style={styles.meta}>#{order.orderId}</span>
    </div>
  );
}

const styles = {
  card: {
    background: '#fff', borderRadius: 10, padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    border: '1px solid #DDD6FE', display: 'flex', flexDirection: 'column' as const, gap: 10,
  },
  top: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  lead: { margin: 0, fontSize: 13, lineHeight: 1.6, color: '#374151' },
  sent: { margin: 0, fontSize: 13, color: '#4338CA', display: 'flex', alignItems: 'center', gap: 8 },
  accept: {
    alignSelf: 'flex-start' as const, background: '#6D28D9', color: '#fff', border: 'none', borderRadius: 6,
    padding: '8px 20px', fontSize: 14, fontWeight: 600 as const, cursor: 'pointer',
  },
  meta: { fontSize: 12, color: '#999' },
};
