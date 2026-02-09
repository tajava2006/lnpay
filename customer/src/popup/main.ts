import { getAllOrders } from '../shared/storage';
import { getStatusMeta } from '../shared/order-states';
import type { TrackedOrder } from '../shared/types';

const MAX_DISPLAY_ORDERS = 5;

async function renderOrders() {
  const orderList = document.getElementById('orderList');
  if (!orderList) return;

  const orders = await getAllOrders();
  const orderArray = Object.values(orders)
    .sort((a, b) => b.updatedAt - a.updatedAt) // 최신순
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
}

function createOrderCard(order: TrackedOrder): string {
  const statusMeta = getStatusMeta(order.status);
  const amount = order.amount > 0 ? `${order.amount.toLocaleString()}원` : '금액 미확인';

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
    </div>
  `;
}

// 전체 보기 버튼 클릭
document.getElementById('openDashboard')?.addEventListener('click', () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('src/dashboard/index.html'),
  });
});

// 초기 렌더링
renderOrders();
