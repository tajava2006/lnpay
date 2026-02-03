// Content Script
// 쿠팡 주문 상세 페이지에서 JSON API를 직접 호출하여 데이터 추출 및 저장

import { getOrder, createOrder } from '../shared/storage';
import { transitionOrderWithRetry } from '../shared/state-machine';
import { isTargetOrder, extractAmount, extractProductName, isPaid } from '../shared/filter';
import type { CoupangOrderData } from '../shared/types';

async function fetchOrderData() {
  // 1. 현재 URL에서 orderId 추출
  const match = window.location.pathname.match(/\/order\/(\d+)/);
  if (!match?.[1]) {
    console.log('[Web Parser] Not an order page');
    return;
  }
  const orderId: string = match[1];
  console.log('[Web Parser] Order ID:', orderId);

  // 2. __NEXT_DATA__에서 buildId 추출
  const nextDataScript = document.getElementById('__NEXT_DATA__');
  if (!nextDataScript) {
    console.error('[Web Parser] __NEXT_DATA__ not found');
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

    // claimed 상태에서 입금 완료 확인 (누군가 사주겠다고 한 상태)
    if (existingOrder.status === 'claimed' && isPaid(orderData, orderId)) {
      const result = await transitionOrderWithRetry(orderId, 'paid');
      if (result.success) {
        console.log('[Web Parser] 🎉 조르기 성공! 그분이 사주셨군요!');
        showSuccessNotification();
      } else {
        console.error('[Web Parser] Failed to transition to paid:', result.error);
      }
    }
  } else {
    // 신규 주문 - 대상인지 확인 후 저장
    if (isTargetOrder(orderData, orderId)) {
      const newOrder = await createOrder({
        orderId,
        productName: extractProductName(orderData, orderId),
        amount: extractAmount(orderData, orderId),
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
      <div style="font-size: 24px; margin-bottom: 8px;">🎉</div>
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
