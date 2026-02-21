// Background Service Worker
// 1. Nostr 키페어 초기화 및 릴레이 리스트 구독
// 2. kind 1111 요청 이벤트 발행 (메시지 기반)
// 3. SPA 네비게이션 감지 (쿠팡)

import { ensureKeypair, subscribeRelayLists, type RequestAction } from '@sajwo-tracker/shared';
import { storage } from '../nostr/storage';
import { startAdminOrderSubscription } from '../nostr/admin-orders';
import { sendRequest, type RequestResult } from '../nostr/publish';
import { getOrder, saveOrder } from '../shared/storage';

// ============================================================
// 릴레이 리스트 + Admin 오더 구독 (모듈 스코프)
// 서비스 워커 활성화될 때마다 실행되어 최신 상태를 유지한다.
// ============================================================

subscribeRelayLists(storage);
void startAdminOrderSubscription();

// ============================================================
// Extension Lifecycle
// ============================================================

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Background] Extension installed');

  const keypair = await ensureKeypair(storage);
  console.log('[Background] User pubkey:', keypair.publicKey);
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[Background] Extension startup');
});

// ============================================================
// SPA Navigation Detection (쿠팡)
// ============================================================

chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.url.includes('/order/')) {
      console.log('[Background] SPA navigation detected:', details.url);
      chrome.tabs.sendMessage(details.tabId, {
        type: 'URL_CHANGED',
        url: details.url,
      });
    }
  },
  { url: [{ hostContains: 'mc.coupang.com' }] }
);

// ============================================================
// Message Handler
// ============================================================

type BackgroundMessage =
  | { type: 'SEND_REQUEST'; orderId: string; action: RequestAction }
  | { type: 'GET_PUBKEY' };

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  if (message.type === 'SEND_REQUEST') {
    handleSendRequest(message.orderId, message.action).then(sendResponse);
    return true; // async response
  }

  if (message.type === 'GET_PUBKEY') {
    ensureKeypair(storage).then((kp) => sendResponse({ publicKey: kp.publicKey }));
    return true;
  }
});

/**
 * 요청 발행 처리:
 * 1. 주문 조회
 * 2. kind 1111 요청 이벤트 발행
 * 3. 발행 성공 시 raw 필드에 서명 이벤트 저장
 */
async function handleSendRequest(orderId: string, action: RequestAction): Promise<RequestResult> {
  try {
    const order = await getOrder(orderId);
    if (!order) {
      return { success: false, publishedTo: [], errors: ['ORDER_NOT_FOUND'] };
    }

    const result = await sendRequest(order, action);

    // 발행 성공 시 raw 필드 저장 (요청 전송 완료 표시)
    if (result.success && result.raw) {
      const latest = await getOrder(orderId);
      if (latest) {
        await saveOrder({ ...latest, raw: result.raw });
      }
    }

    return result;
  } catch (err) {
    console.error('[Background] Send request error:', err);
    return { success: false, publishedTo: [], errors: [String(err)] };
  }
}
