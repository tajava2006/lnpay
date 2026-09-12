/**
 * 통합 구독 오케스트레이터
 *
 * 소켓 구독을 이 모듈이 단독으로 소유하고, 수신 이벤트를 역할별 핸들러로
 * 흘려보낸다. 합치기 전에는 두 앱이 같은 필터로 각자 구독했지만, 이제
 * 한 사람이 두 역할을 겸하므로 소켓도 한 벌이면 충분하다.
 *
 * 역할 분기는 이벤트가 아니라 데이터로 판정한다:
 * - kind 30402: 고객 핸들러는 `customer` 태그가 나인 것만 취하고,
 *   후원자 핸들러는 오더북을 위해 전부 취한다. 한 이벤트가 양쪽에 갈 수 있다.
 * - kind 1111: 고객 핸들러가 먼저 보고, 소화 못 하면 후원자 핸들러로 넘긴다.
 */
import {
  getReadRelays,
  getUserPubkey,
  getSecretKey,
  createSubscriptionGuard,
  storage,
} from '@sajwo-tracker/shared';
import { subscribeOrders, subscribeInbox } from './subscribe';
import * as buyer from '../buyer/nostr/service';
import * as sponsor from '../sponsor/nostr/service';

const guard = createSubscriptionGuard('통합구독');

export function startSubscriptions(): Promise<void> {
  return guard.start(async () => {
    // 두 구독이 한 await 뒤에 함께 만들어져야 한다.
    // 사이에 await이 끼면 그 틈에 stop/start가 갈라져 한쪽만 유실된다.
    const [relays, myPubkey, sk] = await Promise.all([
      getReadRelays(storage),
      getUserPubkey(storage),
      getSecretKey(storage),
    ]);

    let ordersEosed = false;

    const stopOrders = subscribeOrders(relays, {
      onOrder: (event) => {
        buyer.handleAdminOrder(event, myPubkey);
        sponsor.handleAdminOrder(event);
      },
      onEose: () => {
        if (ordersEosed) return;
        ordersEosed = true;
        buyer.handleOrdersEose();
        sponsor.handleOrdersEose();
      },
    });

    const stopInbox = subscribeInbox(relays, myPubkey, {
      onEvent: (event) => {
        if (buyer.handleInboxEvent(event, sk)) return;
        sponsor.handleInboxEvent(event);
      },
      onEose: () => {
        console.log('[Nostr] 수신함 초기 동기화 완료');
      },
    });

    return () => {
      stopOrders();
      stopInbox();
    };
  });
}

export function stopSubscriptions(): void {
  guard.stop();
}
