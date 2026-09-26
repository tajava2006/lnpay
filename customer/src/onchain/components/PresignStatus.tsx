import { useState } from 'react';
import { isPast, presignDeadlineOf, type OnchainOrder } from '@sajwo-tracker/shared/onchain';
import { getMyClaim, rememberMyClaim } from '../claim-store';
import { presignNow } from '../nostr/service';
import { styles } from './card-styles';

/**
 * 후원자: 사전서명 상태.
 *
 * 사전서명은 앱이 자동으로 한다. 다만 **클레임 때 낸 받을 주소·수수료율이 이 기기에
 * 없으면**(다른 기기에서 클레임했거나 저장소가 지워졌을 때) 서명을 못 만들어 마감을
 * 넘기고 보증금을 잃는다. 그 자리에서 다시 입력받는다 — 어드민은 클레임 때 값과
 * 바이트까지 같은 tx만 받으므로 틀리게 넣으면 거절 사유가 돌아온다.
 */
export function PresignStatus({ order, now }: { order: OnchainOrder; now: number }) {
  const claim = getMyClaim(order.orderId);
  const [address, setAddress] = useState('');
  const [feerate, setFeerate] = useState('');
  const [busy, setBusy] = useState(false);

  if (isPast(presignDeadlineOf(order), now)) {
    return <p style={styles.dangerText}>사전서명 마감이 지났습니다. 거래가 환불로 넘어갑니다.</p>;
  }
  if (claim) {
    return <p style={styles.okText}>앱이 자동으로 사전서명합니다. 이 화면을 열어 두세요.</p>;
  }
  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>받을 주소를 다시 입력하세요</p>
      <p style={styles.warnText}>
        이 기기에는 클레임 때 낸 받을 주소·수수료율 기록이 없습니다. <strong>그때와 똑같이</strong>
        입력하면 앱이 바로 사전서명합니다. 마감을 넘기면 보증금을 잃습니다.
      </p>
      <input style={styles.input} placeholder="받을 주소" value={address} onChange={e => setAddress(e.target.value)} />
      <input
        style={styles.input}
        placeholder="수수료율 (sat/vB)"
        inputMode="decimal"
        value={feerate}
        onChange={e => setFeerate(e.target.value.replace(/[^0-9.]/g, ''))}
      />
      <button
        style={styles.primary}
        disabled={busy || !address.trim() || !(Number(feerate) > 0)}
        onClick={() => {
          rememberMyClaim({ orderId: order.orderId, payoutAddress: address.trim(), feerateSatPerVb: Number(feerate) });
          setBusy(true);
          void presignNow(order).finally(() => setBusy(false));
        }}
      >
        {busy ? '서명 중…' : '사전서명하기'}
      </button>
    </div>
  );
}
