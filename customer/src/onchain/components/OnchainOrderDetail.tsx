/**
 * 온체인 주문 하나만 보는 화면
 *
 * ⚠️ **URL에 주문이 남아야 한다.** 이 트랙은 마감이 분 단위인 구간이 있어
 * (사전서명 15분 / 원화 송금 30분) 새로고침 한 번에 보던 자리를 잃으면
 * 그 시간을 그냥 까먹는다. `?track=onchain&tab=history&order=…`로 돌아온다.
 *
 * 카드는 목록과 **같은 컴포넌트**를 쓴다 — 갈리면 한쪽에만 있는 버튼이 생긴다.
 */
import { useSyncExternalStore } from 'react';
import {
  getOnchainOrdersSnapshot, roleIn, subscribeOnchainOrders,
} from '../store';
import { getDepositInvoicesSnapshot, subscribeDepositInvoices } from '../deposit-store';
import { getSignRequestsSnapshot, signRequestsFor, subscribeSignRequests } from '../sign-request-store';
import { OnchainOrderCard } from './OnchainMyOrders';
import { ui } from '../../ui';

interface Props {
  orderId: string;
  myPubkey: string | null;
  onBack: () => void;
}

export function OnchainOrderDetail({ orderId, myPubkey, onBack }: Props) {
  const orders = useSyncExternalStore(subscribeOnchainOrders, getOnchainOrdersSnapshot);
  const invoices = useSyncExternalStore(subscribeDepositInvoices, getDepositInvoicesSnapshot);
  const signRequests = useSyncExternalStore(subscribeSignRequests, getSignRequestsSnapshot);

  const order = orders[orderId];
  const role = order && myPubkey ? roleIn(order, myPubkey) : null;

  return (
    <div style={styles.wrap}>
      <button style={styles.back} onClick={onBack}>← 목록</button>

      {!order ? (
        // 다른 기기에서 열었거나 아직 동기화 전일 수 있다 — 없다고 단정하지 않는다.
        <p style={ui.empty}>이 주문을 아직 못 받았습니다. 잠시 후 다시 보세요.</p>
      ) : !role || !myPubkey ? (
        <p style={ui.empty}>내가 참여한 주문이 아닙니다.</p>
      ) : (
        <OnchainOrderCard
          order={order}
          role={role}
          myPubkey={myPubkey}
          invoiceBolt11={invoices[orderId]?.done ? undefined : invoices[orderId]?.bolt11}
          signRequests={signRequestsFor(signRequests, orderId)}
        />
      )}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column' as const, gap: 12 },
  back: {
    alignSelf: 'flex-start', padding: '6px 10px', fontSize: 13,
    background: '#fff', border: '1px solid #D1D5DB', borderRadius: 8, cursor: 'pointer',
  },
};
