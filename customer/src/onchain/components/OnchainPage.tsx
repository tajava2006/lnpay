/**
 * 온체인 탭 (PLAN-ONCHAIN-TRACK §1.2)
 *
 * 라이트닝과 **탭을 가른다.** 고객 플로우가 완전히 달라(등록이 무료 vs 온체인
 * tx를 쏴야 함) 한 목록에 섞으면 카드마다 "이건 어느 쪽"을 설명해야 한다.
 * 더 큰 이유는 **실서비스 보호** — 라이트닝 트랙은 지금 실제 돈이 돌고 있고,
 * 온체인은 독립적으로 붙였다 뗐다 할 수 있어야 한다.
 */
import { useEffect, useState } from 'react';
import { getUserPubkey, storage } from '@sajwo-tracker/shared';
import { OnchainOrderBook } from './OnchainOrderBook';
import { OnchainOrderForm } from './OnchainOrderForm';
import { OnchainMyOrders } from './OnchainMyOrders';

type Section = 'book' | 'sell' | 'mine';

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'book', label: '사기' },
  { key: 'sell', label: '팔기' },
  { key: 'mine', label: '내 거래' },
];

export function OnchainPage() {
  const [section, setSection] = useState<Section>('book');

  // 내 pubkey — 역할 판정에 쓴다. 로딩 전엔 `null`로 두어 "남의 거래"로
  // 단정하지 않는다(라이트닝 오더북과 같은 규칙).
  const [myPubkey, setMyPubkey] = useState<string | null>(null);
  useEffect(() => {
    void getUserPubkey(storage).then(setMyPubkey);
  }, []);

  return (
    <div style={styles.wrap}>
      <div style={styles.intro}>
        <strong>온체인 거래</strong>
        <p style={styles.introText}>
          2-of-3 taproot 에스크로로 비트코인과 원화를 맞바꿉니다. 수수료는
          <strong> 온체인 네트워크 수수료뿐</strong>이고, 판매자는 펀딩 트랜잭션을,
          구매자는 받는 트랜잭션을 각각 부담합니다. 분쟁이 없으면 운영자는
          아무것도 받지 않습니다.
        </p>
      </div>

      <div style={styles.tabs}>
        {SECTIONS.map(s => (
          <button
            key={s.key}
            style={{ ...styles.tab, ...(section === s.key ? styles.tabActive : {}) }}
            onClick={() => setSection(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === 'book' && <OnchainOrderBook myPubkey={myPubkey} />}
      {section === 'sell' && <OnchainOrderForm onDone={() => setSection('mine')} />}
      {section === 'mine' && <OnchainMyOrders myPubkey={myPubkey} />}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column' as const, gap: 16, padding: '0 4px' },
  intro: { background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 10, padding: '12px 14px' },
  introText: { margin: '6px 0 0', fontSize: 13, color: '#4B5563', lineHeight: 1.6 },
  tabs: { display: 'flex', gap: 6 },
  tab: {
    flex: 1, padding: '9px 0', fontSize: 14, fontWeight: 600 as const,
    background: '#fff', color: '#6B7280', border: '1px solid #E5E7EB',
    borderRadius: 8, cursor: 'pointer',
  },
  tabActive: { background: '#EFF6FF', color: '#2563EB', borderColor: '#BFDBFE' },
};
