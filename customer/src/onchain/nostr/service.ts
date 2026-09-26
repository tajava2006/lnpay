/**
 * 온체인 구독 + 자동 반응
 *
 * 라이트닝 구독과 **소켓을 나눈다.** 필터의 `t` 태그가 달라 한 구독에 못 섞고,
 * 섞으면 구버전 클라이언트가 온체인 오더를 라이트닝으로 렌더링하는 그 사고가
 * 여기서 재현된다.
 *
 * ── 자동으로 하는 것은 하나뿐
 *
 * **후원자의 사전서명**이다. 받을 주소와 feerate는 클레임 때 이미 냈고
 * 금액은 정해져 있으니 판단할 게 없다 — 15분은 앱이 깨어나는 시간이다.
 *
 * ⚠️ **릴리스 최종 서명은 절대 자동이 아니다**(O-007). 고객이 은행 입금을 눈으로
 * 확인하고 누르는 것이고, 그게 유일한 방어선이다.
 */
import type { Event } from 'nostr-tools/core';
import {
  APP_PUBKEY, CLIENT_TAG_ONCHAIN, createSubscriptionGuard, createSubscriptionPool, getReadRelays, getSecretKey,
  getUserPubkey, nip44Decrypt, NOSTR_SINCE, parseAccountInfoEnvelope, MESSAGE_KIND, ORDER_KIND,
  storage,
} from '@sajwo-tracker/shared';
import {
  bytesToHex, fromPsbtBase64, isOnchainPsbtPayload, isOnchainTerminal, isSignPurpose, parseOnchainOrder,
  type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { getOnchainOrder, roleIn, upsertOnchainOrder } from '../store';
import { noteOrderProtocol } from '../../protocol-store';
import { buildPresignature } from '../actions';
import { publishOnchainPresig } from './publish';
import { clearSignRequestsFor, putSignRequest } from '../sign-request-store';
import { putDepositInvoice } from '../deposit-store';
import { forgetPendingRequest, getPendingRequestsSnapshot, markRequestRejected } from '../pending-request-store';
import { putOnchainAccount } from '../account-store';
import { putNotice } from '../notice-store';
import { handleOwnOnchainRequest } from './own-requests';

const guard = createSubscriptionGuard('온체인구독');

/** 사전서명을 이미 보낸 주문 — 릴레이 에코가 오기 전 중복 발행을 막는다 */
const presigning = new Set<string>();

/**
 * 오더보다 먼저 도착한 계좌 정보 (메모리만).
 *
 * 계좌는 **오더의 고객이 보낸 것만** 받는다. 그런데 새로고침하면 오더 구독과
 * 수신함 구독이 따로 돌아 계좌가 먼저 올 수 있다 — 그때 버리면 진짜 계좌를 잃는다.
 * 오더가 도착하면 여기서 꺼내 다시 판정한다. 릴레이가 다시 주므로 저장할 필요는 없다.
 */
const awaitingOrder = new Map<string, Event[]>();
const MAX_BUFFERED_PER_ORDER = 10;

export function startOnchainSubscriptions(): Promise<void> {
  return guard.start(async () => {
    const [relays, myPubkey, sk] = await Promise.all([
      getReadRelays(storage),
      getUserPubkey(storage),
      getSecretKey(storage),
    ]);

    const pool = createSubscriptionPool();

    const orderSub = pool.subscribeMany(
      relays,
      {
        kinds: [ORDER_KIND],
        authors: [APP_PUBKEY],
        '#t': [CLIENT_TAG_ONCHAIN],
        ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
      },
      { onevent: (event: Event) => void handleOrderEvent(event, myPubkey) },
    );

    const inboxSub = pool.subscribeMany(
      relays,
      {
        kinds: [MESSAGE_KIND],
        '#p': [myPubkey],
        '#t': [CLIENT_TAG_ONCHAIN],
        ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
      },
      { onevent: (event: Event) => void handleInboxEvent(event) },
    );

    // 내가 보낸 요청 — 환불 주소·클레임 값을 되살린다(키를 옮긴 기기에서도 서명할 수 있게)
    const ownSub = pool.subscribeMany(
      relays,
      {
        kinds: [MESSAGE_KIND],
        authors: [myPubkey],
        '#t': [CLIENT_TAG_ONCHAIN],
        ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
      },
      { onevent: (event: Event) => handleOwnOnchainRequest(event, sk, myPubkey) },
    );

    console.log('[온체인] 구독 시작 —', relays.length, '릴레이');

    return () => {
      orderSub.close();
      inboxSub.close();
      ownSub.close();
      pool.destroy();
      console.log('[온체인] 구독 종료');
    };
  });
}

export function stopOnchainSubscriptions(): void {
  guard.stop();
}

export async function handleOrderEvent(event: Event, myPubkey: string): Promise<void> {
  noteOrderProtocol(event.tags); // 파싱보다 먼저 — 새 데몬의 이벤트는 못 읽을 수도 있다
  const order = parseOnchainOrder(event, CLIENT_TAG_ONCHAIN);
  if (!order) {
    console.log('[온체인] 오더 이벤트를 못 읽었다 (태그 불일치이거나 모르는 상태)');
    return;
  }
  if (!upsertOnchainOrder(order)) return;
  console.log('[온체인] 오더', order.orderId, '→', order.state);

  // 오더가 생겼으면 "등록 요청 대기"는 끝났다
  forgetPendingRequest(order.orderId);

  // 브로드캐스트됐거나 끝난 주문의 서명 요청은 쓸 데가 없다. 화면은 FSM으로
  // 이미 막지만(`canActOnSignRequest`), 스토어에 남겨두면 다음에 또 헷갈린다.
  if (order.state === 'settling' || isOnchainTerminal(order.state)) {
    clearSignRequestsFor(order.orderId);
  }

  // 오더보다 먼저 온 계좌가 있으면 이제 판정할 수 있다.
  const buffered = awaitingOrder.get(order.orderId);
  if (buffered) {
    awaitingOrder.delete(order.orderId);
    for (const ev of buffered) void handleAccountInfo(ev, order.orderId, myPubkey);
  }

  // 후원자 사전서명 — 여기가 자동인 유일한 자리다. 마감이 지났으면 buildPresignature가 멈춘다.
  if (order.state === 'funded' && !order.settlementKind && roleIn(order, myPubkey) === 'sponsor') {
    void autoPresign(order);
  }
}

/**
 * 계좌 정보 — **오더의 고객이 보낸 것만** 받는다.
 *
 * 전에는 보낸 사람 키로 그냥 복호화해 저장했다. 후원자 pubkey는 오더 태그에 공개돼
 * 있으므로 제3자가 가짜 계좌를 먼저 쏘면 그게 "먼저 온 것"이 돼 진짜 고객 계좌를
 * 밀어냈고, 후원자는 공격자 계좌로 원화를 보냈다.
 */
async function handleAccountInfo(event: Event, orderId: string, myPubkey: string): Promise<void> {
  const order = getOnchainOrder(orderId);
  if (!order) {
    const list = awaitingOrder.get(orderId) ?? [];
    if (list.length < MAX_BUFFERED_PER_ORDER) awaitingOrder.set(orderId, [...list, event]);
    return;
  }
  if (event.pubkey !== order.customerPubkey) {
    console.warn('[온체인] 고객이 아닌 쪽이 보낸 계좌 — 버린다', orderId, event.pubkey.slice(0, 8));
    return;
  }
  if (order.sponsorPubkey !== myPubkey) return;

  try {
    const sk = await getSecretKey(storage);
    const envelope = parseAccountInfoEnvelope(nip44Decrypt(event.content, sk, event.pubkey));
    if (envelope?.accountInfo) {
      putOnchainAccount(orderId, { accountInfo: envelope.accountInfo, salt: envelope.salt });
    }
  } catch (e) {
    console.warn('[온체인] 계좌 정보를 못 열었다', orderId, e);
  }
}

/** 화면에서 직접 부른다 — 받을 주소를 다시 입력한 뒤 곧바로 사전서명할 때 */
export function presignNow(order: OnchainOrder): Promise<void> {
  presigning.delete(order.orderId);
  return autoPresign(order);
}

async function autoPresign(order: OnchainOrder): Promise<void> {
  if (presigning.has(order.orderId)) return;
  presigning.add(order.orderId);
  try {
    const built = await buildPresignature(order);
    if (!built.ok) {
      // 값이 안 맞으면 **서명하지 않는다.** 내가 덜 받는 tx에 서명하는 것보다
      // 마감을 놓치는 게 낫다 — 마감은 보증금만 잃지만 서명은 되돌릴 수 없다.
      console.error('[온체인] 사전서명을 만들 수 없다:', order.orderId, built.reason);
      return;
    }
    const result = await publishOnchainPresig(order.orderId, built.psbt);
    if (!result.success) {
      console.error('[온체인] 사전서명 발행 실패', order.orderId, result.errors);
      presigning.delete(order.orderId); // 다음 에코에 다시 시도
    }
  } finally {
    // 성공했으면 상태가 `presigned`로 바뀌며 이 경로를 더 안 탄다.
    setTimeout(() => presigning.delete(order.orderId), 60_000);
  }
}

export async function handleInboxEvent(event: Event): Promise<void> {
  const action = event.tags.find(t => t[0] === 'action')?.[1];
  const orderId = event.tags.find(t => t[0] === 'a')?.[1]?.split(':')[2];

  /**
   * ⚠️ **받은 것을 전부 남긴다.** 이 핸들러가 모르는 action을 조용히 버리는 바람에
   * 계좌 정보가 통째로 사라진 적이 있다(2026-09-21). "안 온 것"과 "왔는데 못 쓴 것"은
   * 대응이 완전히 다른데, 로그가 없으면 구분할 방법이 없다.
   */
  console.log('[온체인] 수신', action ?? '(action 없음)', orderId ?? '(orderId 없음)',
    'from', event.pubkey.slice(0, 8));

  if (!action || !orderId) return;

  if (action === 'account-info') {
    // 고객이 **나에게 직접** 보낸 계좌다(어드민도 못 본다). 발신자는 여기서 가린다.
    const myPubkey = await getUserPubkey(storage);
    await handleAccountInfo(event, orderId, myPubkey);
    return;
  }

  // ⚠️ 여기부터는 **어드민이 보낸 것**만 받는다. 전에는 발신자를 안 봐서
  // 제3자가 `deposit-required`에 자기 인보이스를 실어 보내면 그게 "보증금 결제" 화면에
  // 떴다 — 라이트닝 트랙은 이미 막고 있던 자리다.
  if (event.pubkey !== APP_PUBKEY) {
    console.warn('[온체인] 어드민이 아닌 쪽의 통지 — 버린다', action, event.pubkey.slice(0, 8));
    return;
  }

  if (action === 'deposit-required') {
    const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1];
    if (bolt11) {
      putDepositInvoice({ orderId, bolt11, receivedAt: event.created_at });
      // 답이 왔다 — 더 기다릴 게 없다
      forgetPendingRequest(orderId);
    }
    return;
  }

  if (action === 'onchain-rejected') {
    // **조용히 사라지지 않게 한다.** 사유가 화면에 남아야 유저가 다음을 정한다.
    const reason = event.tags.find(t => t[0] === 'reason')?.[1] ?? '알 수 없는 사유';
    if (getPendingRequestsSnapshot()[orderId]) markRequestRejected(orderId, reason);
    else putNotice({ orderId, reason, receivedAt: event.created_at });
    return;
  }

  if (action === 'onchain-cosign') {
    // 어드민이 "이 tx에 서명해 달라"고 보낸 것이다. **자동으로 서명하지 않는다** —
    // 화면이 내 기록으로 다시 만들어 대조한 뒤 유저가 누른다.
    const purpose = event.tags.find(t => t[0] === 'purpose')?.[1];
    if (!isSignPurpose(purpose)) return;
    try {
      const sk = await getSecretKey(storage);
      const payload: unknown = JSON.parse(nip44Decrypt(event.content, sk, APP_PUBKEY));
      if (!isOnchainPsbtPayload(payload)) return;
      putSignRequest({
        orderId,
        purpose,
        psbt: payload.psbt,
        receivedAt: event.created_at,
        outpoint: purpose === 'rescue' ? rescueOutpointOf(payload.psbt) : undefined,
      });
    } catch (e) {
      console.warn('[온체인] 서명 요청을 못 열었다', orderId, e);
    }
    return;
  }

  if (action === 'deposit-accepted' || action === 'deposit-cancelled') {
    // 오더 상태가 곧 따라오므로 화면은 그걸 본다. 여기서는 인보이스만 치운다.
    if (action === 'deposit-accepted' || getOnchainOrder(orderId)) {
      putDepositInvoice({ orderId, bolt11: '', receivedAt: event.created_at, done: true });
    }
  }
}

/** 구조 PSBT가 쓰는 UTXO (`txid:vout`) — 같은 주문에 여러 구조가 올 수 있어 키로 쓴다 */
function rescueOutpointOf(psbt: string): string | undefined {
  try {
    const input = fromPsbtBase64(psbt).getInput(0);
    if (!input?.txid || input.index === undefined) return undefined;
    return `${bytesToHex(input.txid)}:${input.index}`;
  } catch {
    return undefined;
  }
}
