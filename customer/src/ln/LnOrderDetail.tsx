/**
 * 라이트닝 의뢰 하나만 보는 화면 — 어느 탭에서 들어와도 같다
 *
 * 위는 목록과 **같은 카드**(할 일이 전부 거기 있다), 아래는 진행도 전체와 대화(상대방 · 운영자 — `chat/TradeChat`). 예전엔 여기에
 * 진행도·채팅만 있어서, 내 거래에서 들어오면 결제할 수 없었다(2026-09-24 드릴).
 *
 * URL에 오더가 남는다(`?order=`) — 새로고침·알림 클릭이 이 화면으로 돌아온다. 다른 오더 모음에서 링크(NIP-69
 * `source`)로 들어온 **남**에게는 오더북 카드를 그린다 — 거기서 바로 맡는다.
 */
import { useEffect, useState } from 'react';
import { OrderProgress, idbGetOrder, sponsorRelation, type Order, type PriceTracker } from '@sajwo-tracker/shared';
import { isClaimableLn } from '@sajwo-tracker/shared/ln';
import { TradeChat } from '../chat/TradeChat';
import { DesignatedOfferCard } from '../sponsor/components/DesignatedOfferCard';
import { OrderCard } from '../sponsor/components/OrderCard';
import { ui } from '../ui';
import { LnOrderCard } from './LnOrderCard';
import { useLnCard } from './use-ln-card';

interface Props {
  orderId: string;
  onBack: () => void;
  tracker: PriceTracker;
}

export function LnOrderDetail({ orderId, onBack, tracker }: Props) {
  // 라이브 스토어에 없으면(보존 끝) IDB 사본으로 그린다
  const [archived, setArchived] = useState<Order | null>(null);
  useEffect(() => {
    void idbGetOrder(orderId).then(o => { if (o) setArchived(o); });
  }, [orderId]);

  const { view, myPubkey, order, local, now } = useLnCard(orderId, archived);
  // 이 기기에 내 기록이 없는 남의 의뢰. 클레임이 풀린 후원자는 IDB 사본이 있어 내 카드로 본다
  const relation = order && !local && !archived ? sponsorRelation(order, myPubkey) : null;

  return (
    <div style={styles.wrap}>
      <button style={styles.back} onClick={onBack}>← 목록으로</button>

      {order && relation === 'open' && !isClaimableLn(order, now) ? (
        <p style={ui.empty}>기한이 얼마 안 남아 지금은 살 수 없는 판매입니다.</p>
      ) : order && relation === 'open' && order.designatedSponsor ? (
        // 나를 지정한 거래 — 알림을 누르면 여기로 온다. 공개 클레임 카드가 아니라 확인 코드·고지를 거치는 수락 카드
        <DesignatedOfferCard order={order} now={now} />
      ) : order && (relation === 'open' || relation === 'taken') ? (
        <OrderCard order={order} now={now} myPubkey={myPubkey} />
      ) : (
        <LnOrderCard orderId={orderId} archived={archived} tracker={tracker} />
      )}

      {view.state && view.role && (
        <OrderProgress
          role={view.role}
          state={view.state}
          accountInfoSent={view.progress.accountInfoSent}
          sponsorDepositPending={view.progress.sponsorDepositPending}
          designated={view.designated !== null}
        />
      )}

      {/* 상대방과 대화(운영자 못 봄) + 운영자는 부를 때만 — 운영자와는 당사자마다 따로다 */}
      {myPubkey && view.role && !view.draft && (
        <TradeChat track="ln" orderId={orderId} myPubkey={myPubkey} role={view.role} peer={view.peer} />
      )}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column' as const, gap: 16 },
  back: {
    alignSelf: 'flex-start' as const, padding: '6px 12px', fontSize: 13, fontWeight: 500 as const, color: '#4F46E5',
    background: 'none', border: '1px solid #C7D2FE', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
  },
};
