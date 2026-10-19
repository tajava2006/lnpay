/**
 * 오더북 카드의 머리(금액 · 남은 시간)와 틀 — 남의 의뢰 카드(`OrderCard`)와 나를 지정한 의뢰 카드(`DesignatedOfferCard`)가
 * 같이 쓴다. 따로 두니 기한 0("기한 없음") 처리와 임박 색이 벌써 갈렸다.
 */
import { remainingText } from '@sajwo-tracker/shared';
import { ui } from '../../ui';

/** 이보다 적게 남으면 빨갛게 */
const URGENT_SEC = 3600;

export const bookCardStyle = {
  background: '#fff', borderRadius: 10, padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};

export function BookCardHead({ price, expiration, now }: { price: number; expiration: number; now: number }) {
  const urgent = expiration > 0 && expiration - now < URGENT_SEC;
  return (
    <div style={styles.top}>
      <span style={ui.price}>{price.toLocaleString()}원</span>
      <span style={{ ...ui.timeLeft, color: urgent ? '#DC2626' : '#666' }}>
        {expiration === 0 ? '기한 없음' : remainingText(expiration - now, '기한 지남')}
      </span>
    </div>
  );
}

const styles = {
  top: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
};
