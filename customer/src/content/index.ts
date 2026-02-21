// Content Script
// 쿠팡 주문 상세 페이지에서 JSON API를 직접 호출하여 데이터 추출 및 저장

import { getOrder, createOrder } from '../shared/storage';
import { isFinal } from '../shared/order-states';
import { isTargetOrder, extractAmount, extractProductName, extractVirtualAccount, extractOrderedAt, isPaid, isCancelled } from '../shared/filter';
import type { CoupangOrderData } from '../shared/types';

/**
 * __NEXT_DATA__ 스크립트가 나타날 때까지 대기
 * Next.js 앱에서 DOM 로드 후에도 스크립트가 파싱되기까지 시간이 걸릴 수 있음
 */
async function waitForNextData(maxAttempts = 20, interval = 100): Promise<HTMLElement | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const script = document.getElementById('__NEXT_DATA__');
    if (script) {
      return script;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return null;
}

async function fetchOrderData() {
  // 1. 현재 URL에서 orderId 추출
  const match = window.location.pathname.match(/\/order\/(\d+)/);
  if (!match?.[1]) {
    console.log('[Web Parser] Not an order page');
    return;
  }
  const orderId: string = match[1];
  console.log('[Web Parser] Order ID:', orderId);

  // 2. __NEXT_DATA__가 나타날 때까지 대기 (최대 2초)
  const nextDataScript = await waitForNextData();
  if (!nextDataScript) {
    console.warn('[Web Parser] __NEXT_DATA__ not found after waiting');
    return;
  }

  let buildId: string;
  try {
    const nextData = JSON.parse(nextDataScript.textContent || '');
    buildId = nextData.buildId;
    console.log('[Web Parser] Build ID:', buildId);
  } catch (e) {
    console.error('[Web Parser] Failed to parse __NEXT_DATA__:', e);
    return;
  }

  // 3. JSON API URL 구성
  const jsonUrl = `https://mc.coupang.com/ssr/_next/data/${buildId}/desktop/order/${orderId}.json?orderId=${orderId}`;
  console.log('[Web Parser] Fetching:', jsonUrl);

  // 4. fetch로 호출
  let orderData: CoupangOrderData;
  try {
    const response = await fetch(jsonUrl, {
      credentials: 'include',
    });

    if (!response.ok) {
      console.error('[Web Parser] Fetch failed:', response.status, response.statusText);
      return;
    }

    orderData = await response.json();
    console.log('[Web Parser] Order JSON captured:', orderData);
  } catch (e) {
    console.error('[Web Parser] Fetch error:', e);
    return;
  }

  // 5. 기존 저장된 주문 확인
  const existingOrder = await getOrder(orderId);

  if (existingOrder) {
    // 이미 추적 중인 주문 - 상태 변경 확인
    console.log('[Web Parser] Existing order found:', existingOrder);

    // 최종 상태면 더 이상 확인할 필요 없음
    if (isFinal(existingOrder)) {
      console.log('[Web Parser] Order already in final state:', existingOrder.adminState);
      return;
    }

    // 취소 감지 → Admin에 cancel-request 전송
    if (isCancelled(orderData, orderId)) {
      console.log('[Web Parser] Order cancelled detected on Coupang');
      chrome.runtime.sendMessage({
        type: 'SEND_REQUEST',
        orderId,
        action: 'cancel-request',
      });
      return;
    }

    // 입금 완료 감지 → Admin에 payment-confirm 전송
    if (isPaid(orderData, orderId)) {
      console.log('[Web Parser] Payment detected on Coupang');
      chrome.runtime.sendMessage({
        type: 'SEND_REQUEST',
        orderId,
        action: 'payment-confirm',
      });
      if (existingOrder.adminState === 'escrowed') {
        showSuccessNotification();
      }
    }
  } else {
    // 신규 주문 - 대상인지 확인 후 저장
    if (isTargetOrder(orderData, orderId)) {
      const virtualAccount = extractVirtualAccount(orderData, orderId);
      if (!virtualAccount) {
        console.error('[Web Parser] Failed to extract virtual account info');
        return;
      }

      const newOrder = await createOrder({
        orderId,
        productName: extractProductName(orderData, orderId),
        amount: extractAmount(orderData, orderId),
        virtualAccount,
        orderedAt: extractOrderedAt(orderData, orderId),
      });

      console.log('[Web Parser] New order saved:', newOrder);
    } else {
      console.log('[Web Parser] Order is not a target (not bank transfer or already completed)');
    }
  }
}

// 성공 알림 표시
function showSuccessNotification() {
  const notification = document.createElement('div');
  notification.innerHTML = `
    <div style="
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px 24px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: slideIn 0.5s ease-out;
    ">
      <div style="font-size: 16px; font-weight: bold;">조르기 성공!</div>
      <div style="font-size: 14px; opacity: 0.9;">그분이 사주셨군요!</div>
    </div>
    <style>
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
    </style>
  `;
  document.body.appendChild(notification);

  // 5초 후 자동 제거
  setTimeout(() => notification.remove(), 5000);
}

// 페이지 로드 완료 후 실행
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', fetchOrderData);
} else {
  fetchOrderData();
}

// Background Script에서 SPA 네비게이션 감지 시 메시지 수신
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'URL_CHANGED') {
    console.log('[Web Parser] URL changed via SPA navigation:', message.url);
    // 약간의 딜레이 후 실행 (페이지 데이터 로드 대기)
    setTimeout(fetchOrderData, 500);
  }
});

console.log('[Web Parser] Content script loaded on:', window.location.href);
