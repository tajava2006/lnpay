import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, getSyncedSnapshot } from '../order-store';
import { isTerminalState, sponsorRelation, useNow, type Order, type PriceTracker } from '@sajwo-tracker/shared';
import { isClaimableLn } from '@sajwo-tracker/shared/ln';
import { useMyPubkey } from '../../hooks';
import { LnOrderCard } from '../../ln/LnOrderCard';
import { DesignatedHeader } from '../../designated/components';
import { designatedLnOffers, isOnLnBook } from '../../designated/view';
import { DesignatedOfferCard } from './DesignatedOfferCard';
import { OrderCard } from './OrderCard';

interface Props {
  tracker: PriceTracker;
  onSelectOrder: (orderId: string) => void;
}

/**
 * 사주기 탭 — 지정 거래(머리 · 나를 지정한 거래) 아래 공개 오더북. 저장소·내 키·지금은 여기서 한 번만 읽어 내린다 —
 * 두 목록이 서로 다른 `now`로 클레임 가능 여부를 보면 같은 의뢰가 한쪽에서만 사라진다
 */
export function OrderBook({ tracker, onSelectOrder }: Props) {
  const orders = useSyncExternalStore(subscribe, getSnapshot);
  const synced = useSyncExternalStore(subscribe, getSyncedSnapshot);
  // 내 pubkey — 남의 거래인지 판정하는 데 쓴다. 로딩 전엔 null로 두어
  // '다른 후원자가 진행 중'이 깜빡였다 바뀌는 일이 없게 한다.
  const myPubkey = useMyPubkey();
  const now = useNow();
  const offers = designatedLnOffers(Object.values(orders), myPubkey, now);
  return (
    <div>
      <DesignatedHeader track="ln" />
      {offers.length > 0 && (
        <>
          <h2 className="section-title">나를 지정한 거래</h2>
          <div style={{ ...styles.list, marginBottom: 24 }}>
            {offers.map(o => <DesignatedOfferCard key={o.orderId} order={o} now={now} />)}
          </div>
        </>
      )}
      <PublicBook
        tracker={tracker} onSelectOrder={onSelectOrder} orders={orders} synced={synced} myPubkey={myPubkey} now={now}
      />
    </div>
  );
}

function PublicBook({ tracker, onSelectOrder, orders, synced, myPubkey, now }: Props & {
  orders: Readonly<Record<string, Order>>; synced: boolean; myPubkey: string | null; now: number;
}) {

  // 비종료 오더만, 기한 임박순.
  //
  // 의뢰(requested)는 **클레임할 틈이 있는 것만** — 기한 1시간 안쪽은 데몬이 클레임을 받지 않는다.
  // 진행 중인 내 거래는 기한이 지나도 남긴다 — 기한 직후의 송금 완료·판정이 제일 중요한 순간이다
  // 남의 진행 중 거래는 기한까지만.
  //
  // 지정 거래는 오더북이 아니다 — 내가 맡은 건 "내가 사주는 중", 나를 지정한 건 위 칸, 내가 지정한 건 의뢰하기 탭
  const activeOrders = Object.values(orders)
    .filter((o: Order) => sponsorRelation(o, myPubkey) === 'mine' || isOnLnBook(o))
    .filter((o: Order) => {
      if (isTerminalState(o.state)) return false;
      if (o.state === 'requested') return isClaimableLn(o, now);
      return (myPubkey !== null && o.sponsorPubkey === myPubkey) || o.expiration > now;
    })
    .sort((a: Order, b: Order) => {
      if (a.expiration === 0 && b.expiration === 0) return 0;
      if (a.expiration === 0) return 1;
      if (b.expiration === 0) return -1;
      return a.expiration - b.expiration;
    });

  if (activeOrders.length === 0 && !synced) {
    return <div style={styles.message}>의뢰를 불러오는 중...</div>;
  }

  if (activeOrders.length === 0) {
    return <div style={styles.message}>지금 올라온 의뢰가 없습니다</div>;
  }

  // 내가 사주는 의뢰는 위에 따로 — 할 일이 있는 자리다. 내가 참여한 의뢰(사주는 것·올린 것)는 어느 탭에서든
  // 같은 카드(LnOrderCard)로 그린다. 남의 의뢰만 오더북 카드다
  const sponsoring = activeOrders.filter(o => sponsorRelation(o, myPubkey) === 'mine');
  const book = activeOrders.filter(o => sponsorRelation(o, myPubkey) !== 'mine');

  return (
    <div>
      {!synced && <div style={styles.syncBadge}>동기화 중...</div>}
      {sponsoring.length > 0 && (
        <>
          <h2 className="section-title">내가 맡은 의뢰</h2>
          <div style={{ ...styles.list, marginBottom: 24 }}>
            {sponsoring.map(o => <LnOrderCard key={o.orderId} orderId={o.orderId} tracker={tracker} onOpen={onSelectOrder} />)}
          </div>
          {book.length > 0 && <h2 className="section-title">오더북</h2>}
        </>
      )}
      <div style={styles.list}>
        {book.map((order: Order) => (
          sponsorRelation(order, myPubkey) === 'own'
            ? <LnOrderCard key={order.orderId} orderId={order.orderId} tracker={tracker} onOpen={onSelectOrder} />
            : <OrderCard key={order.orderId} order={order} now={now} myPubkey={myPubkey} />
        ))}
      </div>
    </div>
  );
}

const styles = {
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  message: {
    textAlign: 'center' as const,
    padding: 48,
    color: '#666',
    fontSize: 14,
  },
  syncBadge: {
    textAlign: 'center' as const,
    padding: '6px 0',
    marginBottom: 12,
    fontSize: 12,
    color: '#999',
  },
};
