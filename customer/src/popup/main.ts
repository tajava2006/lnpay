import { getAllOrders } from '../shared/storage';
import { getStatusMeta } from '../shared/order-states';
import type { TrackedOrder } from '../shared/types';
import { createPriceTracker } from '@sajwo-tracker/shared';

const MAX_DISPLAY_ORDERS = 5;

async function renderOrders() {
  const orderList = document.getElementById('orderList');
  if (!orderList) return;

  const orders = await getAllOrders();
  const orderArray = Object.values(orders)
    .sort((a, b) => a.virtualAccount.expirationDate - b.virtualAccount.expirationDate) // 만료 임박순
    .slice(0, MAX_DISPLAY_ORDERS);

  if (orderArray.length === 0) {
    orderList.innerHTML = `
      <div class="empty-state">
        <p>추적 중인 주문이 없습니다</p>
      </div>
    `;
    return;
  }

  orderList.innerHTML = orderArray.map((order) => createOrderCard(order)).join('');

  // 사줘 요청 버튼 이벤트 연결
  orderList.querySelectorAll('.btn-publish').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const orderId = (e.target as HTMLElement).dataset.orderId;
      if (orderId) publishOrder(orderId, e.target as HTMLButtonElement);
    });
  });
}

function createOrderCard(order: TrackedOrder): string {
  const statusMeta = getStatusMeta(order.status);
  const amount = order.amount > 0 ? `${order.amount.toLocaleString()}원` : '금액 미확인';
  const showPublish = order.status === 'detected';

  return `
    <div class="order-card">
      <div class="order-name">${order.productName}</div>
      <div class="order-amount">${amount}</div>
      <div class="order-meta">
        <span class="order-id">#${order.orderId}</span>
        <span class="order-status" style="background: ${statusMeta.bgColor}; color: ${statusMeta.textColor};">
          ${statusMeta.label}
        </span>
      </div>
      ${showPublish ? `<button class="btn-publish" data-order-id="${order.orderId}">사줘 요청</button>` : ''}
    </div>
  `;
}

async function publishOrder(orderId: string, btn: HTMLButtonElement) {
  btn.disabled = true;
  btn.textContent = '요청 중...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'PUBLISH_ORDER',
      orderId,
    });

    if (response?.success) {
      btn.textContent = '요청 완료';
      // 상태 반영을 위해 리렌더
      setTimeout(renderOrders, 500);
    } else {
      btn.textContent = '실패 - 재시도';
      btn.disabled = false;
      console.error('[Popup] Publish failed:', response?.error);
    }
  } catch (err) {
    btn.textContent = '실패 - 재시도';
    btn.disabled = false;
    console.error('[Popup] Publish error:', err);
  }
}

// 전체 보기 버튼 클릭
document.getElementById('openDashboard')?.addEventListener('click', () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('src/dashboard/index.html'),
  });
});

// Storage 변경 감지하여 실시간 업데이트
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.orders) {
    renderOrders();
  }
});

// BTC 가격 추적
const priceTracker = createPriceTracker();
priceTracker.subscribe(() => {
  const snap = priceTracker.getSnapshot();
  const valueEl = document.getElementById('btcPriceValue');
  const dotEl = document.getElementById('btcPriceDot');
  if (valueEl) {
    valueEl.textContent = snap.price !== null
      ? `${snap.price.toLocaleString('ko-KR')}원`
      : '연결 중...';
  }
  if (dotEl) {
    const connected = snap.exchanges.some(e => e.connected);
    dotEl.classList.toggle('connected', connected);
  }
});
priceTracker.start();

// 초기 렌더링
renderOrders();
