/**
 * 나를 지정한 라이트닝 의뢰 하나 — 합의한 금액·기한 확인 + 위험 고지 → [수락] (docs/LN-TRACK.md §7)
 *
 * 수락은 공개 의뢰의 "사줄게"와 같은 클레임이다. 데몬이 지정된 사람인지 보고, **보증금 없이 바로 승인**한다 —
 * 그래서 누르면 곧 고객 결제 단계로 넘어가고 이 카드는 "내가 사주는 중"으로 옮겨 간다.
 */
import { useState } from 'react';
import { guarded, type Order } from '@sajwo-tracker/shared';
import { DesignatedAcceptConsent } from '../../designated/components';
import { publishClaim } from '../nostr/claim';
import { BookCardHead, bookCardStyle } from './BookCardHead';

/** 이만큼 지나도 "내가 사주는 중"으로 안 옮겨 가면 늦는다고 말하고 다시 보낼 수 있게 한다(데몬이 무시했을 수도 있다) */
const SLOW_SEC = 45;

export const DesignatedOfferCard = guarded(DesignatedOfferCardBody, '지정 거래 카드');

function DesignatedOfferCardBody({ order, now }: { order: Order; now: number }) {
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [sending, setSending] = useState(false);
  /** 수락을 보낸 시각(초). 카드가 아직 떠 있다 = 오더가 아직 `requested`다 */
  const [sentAt, setSentAt] = useState<number | null>(null);
  const slow = sentAt !== null && now - sentAt > SLOW_SEC;

  async function accept() {
    setSending(true);
    try {
      if (await publishClaim(order)) setSentAt(Math.floor(Date.now() / 1000));
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
      <BookCardHead price={order.price} expiration={order.expiration} now={now} />
      <p style={styles.lead}>
        고객이 나를 상대로 지정한 의뢰입니다. 수락하면 바로 내가 맡고, 고객이 결제하면 BTC 받을 인보이스를 등록하게 됩니다.
      </p>
      {sentAt !== null ? (
        <>
          <p style={styles.sent}><span className="spinner" /> 수락을 보냈습니다 — 확인되면 "내가 맡은 의뢰"로 옮겨 갑니다.</p>
          {slow && (
            <>
              <p style={styles.hint}>응답이 늦습니다. 기한이 코앞이거나 다른 기기의 키로 지정됐을 수 있습니다.</p>
              <button type="button" style={styles.ghost} disabled={sending} onClick={() => void accept()}>
                {sending ? '보내는 중...' : '다시 보내기'}
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <DesignatedAcceptConsent track="ln" checked={riskAccepted} onChange={setRiskAccepted} />
          <button
            type="button"
            style={{ ...styles.accept, opacity: riskAccepted && !sending ? 1 : 0.5 }}
            disabled={!riskAccepted || sending}
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
  card: { ...bookCardStyle, border: '1px solid #DDD6FE', display: 'flex', flexDirection: 'column' as const, gap: 10 },
  lead: { margin: 0, fontSize: 13, lineHeight: 1.6, color: '#374151' },
  sent: { margin: 0, fontSize: 13, color: '#4338CA', display: 'flex', alignItems: 'center', gap: 8 },
  hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: '#6B7280' },
  ghost: {
    alignSelf: 'flex-start' as const, padding: '6px 12px', fontSize: 12, background: '#fff', color: '#4B5563',
    border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer',
  },
  accept: {
    alignSelf: 'flex-start' as const, background: '#6D28D9', color: '#fff', border: 'none', borderRadius: 6,
    padding: '8px 20px', fontSize: 14, fontWeight: 600 as const, cursor: 'pointer',
  },
  meta: { fontSize: 12, color: '#999' },
};
