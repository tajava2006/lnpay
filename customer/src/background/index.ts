// Background Service Worker
// 1. Nostr 키페어 초기화 및 릴레이 디스커버리
// 2. 사줘 요청 이벤트 발행 (메시지 기반)
// 3. SPA 네비게이션 감지 (쿠팡)

import { ensureKeypair } from '../nostr/keys';
import { refreshRelays } from '../nostr/relays';
import { publishOrder } from '../nostr/publish';
import { getOrder } from '../shared/storage';
import { transitionOrderWithRetry } from '../shared/state-machine';
import { RELAY_REFRESH_ALARM, RELAY_REFRESH_INTERVAL_MINUTES } from '../nostr/constants';

// ============================================================
// Extension Lifecycle
// ============================================================

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Background] Extension installed');

  const keypair = await ensureKeypair();
  console.log('[Background] User pubkey:', keypair.publicKey);

  await refreshRelays();

  chrome.alarms.create(RELAY_REFRESH_ALARM, {
    periodInMinutes: RELAY_REFRESH_INTERVAL_MINUTES,
  });
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Background] Extension startup');

  // 알람이 사라졌을 경우를 대비하여 재생성
  const alarm = await chrome.alarms.get(RELAY_REFRESH_ALARM);
  if (!alarm) {
    chrome.alarms.create(RELAY_REFRESH_ALARM, {
      periodInMinutes: RELAY_REFRESH_INTERVAL_MINUTES,
    });
  }
});

// ============================================================
// Alarm: 릴레이 리스트 주기적 갱신
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RELAY_REFRESH_ALARM) {
    console.log('[Background] Refreshing relay list...');
    await refreshRelays();
  }
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
  | { type: 'PUBLISH_ORDER'; orderId: string }
  | { type: 'GET_PUBKEY' };

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  if (message.type === 'PUBLISH_ORDER') {
    handlePublishOrder(message.orderId).then(sendResponse);
    return true; // async response
  }

  if (message.type === 'GET_PUBKEY') {
    ensureKeypair().then((kp) => sendResponse({ publicKey: kp.publicKey }));
    return true;
  }
});

/**
 * 사줘 요청 발행 처리:
 * 1. 주문 조회
 * 2. detected 상태면 requested로 전이
 * 3. Nostr 이벤트로 브로드캐스트
 */
async function handlePublishOrder(orderId: string) {
  try {
    const order = await getOrder(orderId);
    if (!order) {
      return { success: false, error: 'ORDER_NOT_FOUND' };
    }

    // detected → requested 전이
    if (order.status === 'detected') {
      const result = await transitionOrderWithRetry(orderId, 'requested');
      if (!result.success) {
        return { success: false, error: 'TRANSITION_FAILED', detail: result.error };
      }

      const updatedOrder = await getOrder(orderId);
      if (!updatedOrder) {
        return { success: false, error: 'ORDER_NOT_FOUND_AFTER_TRANSITION' };
      }

      return publishOrder(updatedOrder);
    }

    // 이미 requested 이상이면 현재 상태로 재발행 (상태 업데이트 반영)
    return publishOrder(order);
  } catch (err) {
    console.error('[Background] Publish error:', err);
    return { success: false, error: String(err) };
  }
}
