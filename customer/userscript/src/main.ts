/**
 * 사줘 트래커 - 쿠팡 유저스크립트 엔트리포인트
 *
 * 쿠팡 주문 상세 페이지에서 무통장입금 주문을 자동 감지하고,
 * Nostr 릴레이를 통해 Customer 웹앱에 알린다.
 */
import { ensureNsec, getProcessedOrders, markProcessed, getCachedRelays, setCachedRelays } from './storage';
import {
  extractOrderIdFromUrl,
  fetchCoupangOrder,
  isTargetOrder,
  extractProductName,
  extractVirtualAccount,
  isCancelled,
  isPaid,
} from './coupang';
import {
  decodeNsec,
  discoverRelays,
  publishToRelays,
  buildParsedOrderEvent,
  buildPaymentConfirmEvent,
  buildCancelRequestEvent,
} from './nostr';

async function main() {
  console.log('[사줘] main() 진입');

  // 1. 키 확인
  const nsec = ensureNsec();
  if (!nsec) {
    console.log('[사줘] 키 미입력, 종료');
    return;
  }

  let sk: Uint8Array;
  try {
    sk = decodeNsec(nsec);
  } catch (e) {
    alert('[사줘 트래커] 유효하지 않은 nsec입니다. 설정에서 키를 다시 확인하세요.');
    console.error('[사줘] nsec decode error:', e);
    return;
  }

  // 2. URL에서 orderId 추출
  const orderId = extractOrderIdFromUrl();
  if (!orderId) {
    console.log('[사줘] Not an order page');
    return;
  }
  console.log('[사줘] Order ID:', orderId);

  // 3. 릴레이 디스커버리 (캐시 또는 one-shot)
  let relays = getCachedRelays();
  if (!relays) {
    console.log('[사줘] Discovering relays...');
    relays = await discoverRelays();
    setCachedRelays(relays);
    console.log('[사줘] Relays:', relays);
  }

  // 4. 쿠팡 JSON API에서 주문 데이터 가져오기
  const orderData = await fetchCoupangOrder(orderId);
  if (!orderData) {
    console.log('[사줘] Failed to fetch order data');
    return;
  }

  // 5. 처리 이력 확인
  const processed = getProcessedOrders();

  // 6. 신규 주문: 무통장입금 미결제 → parsed-order 발행
  if (!processed[orderId]?.status && isTargetOrder(orderData, orderId)) {
    const account = extractVirtualAccount(orderData, orderId);
    if (!account) {
      console.log('[사줘] Failed to extract virtual account');
      return;
    }

    const payload = {
      coupangOrderId: orderId,
      productName: extractProductName(orderData, orderId),
      price: account.depositPrice,
      bankName: account.bankName,
      accountNumber: account.accountNumber,
      depositor: account.depositor,
      expirationDate: account.expirationDate,
    };

    console.log('[사줘] New order detected:', payload);

    const signed = buildParsedOrderEvent(sk, payload);
    const result = await publishToRelays(signed, relays);

    if (result.success) {
      markProcessed(orderId, 'parsed', Math.floor(account.expirationDate / 1000));
      console.log('[사줘] parsed-order published to', result.publishedTo.length, 'relays');
      showNotification('주문 감지됨', `${payload.productName} — ₩${payload.price.toLocaleString()}`);
    } else {
      console.error('[사줘] Failed to publish parsed-order');
    }
    return;
  }

  // 7. 기존 처리 주문: 상태 변화 감지
  const entry = processed[orderId];
  if (entry) {
    const { status, expiration } = entry;

    // 취소 감지
    if (isCancelled(orderData, orderId) && status !== 'cancelled') {
      console.log('[사줘] Cancellation detected for', orderId);
      const signed = buildCancelRequestEvent(sk, orderId, expiration);
      const result = await publishToRelays(signed, relays);
      if (result.success) {
        markProcessed(orderId, 'cancelled', expiration);
        console.log('[사줘] cancel-request published');
      }
      return;
    }

    // 입금 완료 감지
    if (isPaid(orderData, orderId) && status !== 'paid') {
      console.log('[사줘] Payment detected for', orderId);
      const signed = buildPaymentConfirmEvent(sk, orderId, expiration);
      const result = await publishToRelays(signed, relays);
      if (result.success) {
        markProcessed(orderId, 'paid', expiration);
        console.log('[사줘] payment-confirm published');
        showNotification('입금 완료 감지', '쿠팡 입금이 확인되었습니다.');
      }
      return;
    }

    console.log('[사줘] Order already processed as:', status);
  }
}

/** 페이지 상단에 알림 표시 */
function showNotification(title: string, message: string) {
  const wrapper = document.createElement('div');

  const card = document.createElement('div');
  Object.assign(card.style, {
    position: 'fixed', top: '16px', right: '16px', zIndex: '999999',
    background: 'linear-gradient(135deg, #667eea, #764ba2)',
    color: 'white', padding: '16px 20px', borderRadius: '10px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    animation: 'sajwoSlideIn 0.4s ease-out',
    maxWidth: '320px',
  });

  const titleEl = document.createElement('div');
  Object.assign(titleEl.style, { fontWeight: '700', fontSize: '14px', marginBottom: '4px' });
  titleEl.textContent = `[사줘] ${title}`;

  const msgEl = document.createElement('div');
  Object.assign(msgEl.style, { fontSize: '13px', opacity: '0.9' });
  msgEl.textContent = message;

  card.append(titleEl, msgEl);

  const style = document.createElement('style');
  style.textContent = `@keyframes sajwoSlideIn { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`;

  wrapper.append(card, style);
  document.body.appendChild(wrapper);
  setTimeout(() => wrapper.remove(), 5000);
}

// ── 실행 ─────────────────────────────────────────────

main().catch(e => console.error('[사줘] Unhandled error:', e));
