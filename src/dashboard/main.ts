import { getAllOrders, deleteOrder, clearAllOrders } from '../shared/storage';
import { getStatusMeta, isFinalStatus } from '../shared/order-states';
import type { TrackedOrder } from '../shared/types';

async function renderDashboard() {
  const orders = await getAllOrders();
  const orderArray = Object.values(orders).sort((a, b) => b.updatedAt - a.updatedAt);

  // 통계 업데이트 (활성 주문 vs 완료 주문)
  const activeCount = orderArray.filter((o) => !isFinalStatus(o.status)).length;
  const completedCount = orderArray.filter((o) => isFinalStatus(o.status)).length;

  document.getElementById('activeCount')!.textContent = String(activeCount);
  document.getElementById('completedCount')!.textContent = String(completedCount);
  document.getElementById('totalCount')!.textContent = String(orderArray.length);

  // 테이블 렌더링
  const tbody = document.getElementById('orderTableBody');
  if (!tbody) return;

  if (orderArray.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state">추적 중인 주문이 없습니다</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = orderArray.map((order) => createTableRow(order)).join('');

  // 삭제 버튼 이벤트 연결
  tbody.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const orderId = (e.target as HTMLElement).dataset.orderId;
      if (orderId && confirm('이 주문을 삭제하시겠습니까?')) {
        await deleteOrder(orderId);
        renderDashboard();
      }
    });
  });
}

function createTableRow(order: TrackedOrder): string {
  const statusMeta = getStatusMeta(order.status);
  const amount = order.amount > 0 ? `${order.amount.toLocaleString()}원` : '금액 미확인';
  const date = new Date(order.createdAt).toLocaleDateString('ko-KR');
  const orderUrl = `https://mc.coupang.com/ssr/desktop/order/${order.orderId}`;

  return `
    <tr>
      <td>
        <a href="${orderUrl}" target="_blank" class="order-link">${order.orderId}</a>
      </td>
      <td>${order.productName}</td>
      <td>${amount}</td>
      <td>
        <span class="order-status" style="background: ${statusMeta.bgColor}; color: ${statusMeta.textColor};">
          ${statusMeta.label}
        </span>
      </td>
      <td>${date}</td>
      <td class="actions">
        <button class="btn btn-danger btn-delete" data-order-id="${order.orderId}">삭제</button>
      </td>
    </tr>
  `;
}

// 전체 삭제 버튼
document.getElementById('clearAll')?.addEventListener('click', async () => {
  if (confirm('모든 주문을 삭제하시겠습니까?')) {
    await clearAllOrders();
    renderDashboard();
  }
});

// Storage 변경 감지하여 실시간 업데이트
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.orders) {
    renderDashboard();
  }
});

// 초기 렌더링
renderDashboard();
