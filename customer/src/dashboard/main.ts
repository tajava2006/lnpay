import { getAllOrders, deleteOrder, clearAllOrders } from '../shared/storage';
import { getDisplayMeta, isFinal, isDeletable } from '../shared/order-states';
import type { TrackedOrder } from '../shared/types';
import { createPriceTracker } from '@sajwo-tracker/shared';

async function renderDashboard() {
  const orders = await getAllOrders();
  const orderArray = Object.values(orders).sort((a, b) => a.virtualAccount.expirationDate - b.virtualAccount.expirationDate); // 만료 임박순

  // 통계 업데이트 (활성 주문 vs 완료 주문)
  const activeCount = orderArray.filter((o) => !isFinal(o)).length;
  const completedCount = orderArray.filter((o) => isFinal(o)).length;

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

  // Dev 패널 주문 드롭다운 갱신
  if (import.meta.env.DEV) {
    import('../dev-only/panel').then((mod) => mod.refreshOrderSelect(orders));
  }

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

  // 사줘 요청 버튼 이벤트 연결
  tbody.querySelectorAll('.btn-publish').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const orderId = (e.target as HTMLElement).dataset.orderId;
      if (orderId) sendOrderRequest(orderId, e.target as HTMLButtonElement);
    });
  });
}

function createTableRow(order: TrackedOrder): string {
  const displayMeta = getDisplayMeta(order);
  const amount = order.amount > 0 ? `${order.amount.toLocaleString()}원` : '금액 미확인';
  const date = new Date(order.createdAt).toLocaleDateString('ko-KR');
  const orderUrl = `https://mc.coupang.com/ssr/desktop/order/${order.orderId}`;
  const showPublish = !order.raw;
  const canDelete = isDeletable(order);

  return `
    <tr>
      <td>
        <a href="${orderUrl}" target="_blank" class="order-link">${order.orderId}</a>
      </td>
      <td>${order.productName}</td>
      <td>${amount}</td>
      <td>
        <span class="order-status" style="background: ${displayMeta.bgColor}; color: ${displayMeta.textColor};">
          ${displayMeta.label}
        </span>
      </td>
      <td>${date}</td>
      <td class="actions">
        ${showPublish ? `<button class="btn btn-publish" data-order-id="${order.orderId}">사줘</button>` : ''}
        ${canDelete ? `<button class="btn btn-danger btn-delete" data-order-id="${order.orderId}">삭제</button>` : ''}
      </td>
    </tr>
  `;
}

async function sendOrderRequest(orderId: string, btn: HTMLButtonElement) {
  btn.disabled = true;
  btn.textContent = '요청 중...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SEND_REQUEST',
      orderId,
      action: 'order-request',
    });

    if (response?.success) {
      btn.textContent = '완료';
      // storage 변경 리스너가 리렌더를 트리거함
    } else {
      btn.textContent = '실패';
      btn.disabled = false;
      console.error('[Dashboard] Send request failed:', response?.errors);
    }
  } catch (err) {
    btn.textContent = '실패';
    btn.disabled = false;
    console.error('[Dashboard] Send request error:', err);
  }
}

// 전체 삭제 버튼
document.getElementById('clearAll')?.addEventListener('click', async () => {
  if (confirm('모든 주문을 삭제하시겠습니까?')) {
    const deleted = await clearAllOrders();
    if (!deleted) {
      alert('거래 진행 중인 주문이 있어 전체 삭제할 수 없습니다.');
    }
    renderDashboard();
  }
});

// Storage 변경 감지하여 실시간 업데이트
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.orders) {
    renderDashboard();
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
      ? `${snap.price.toLocaleString('ko-KR')}`
      : '-';
  }
  if (dotEl) {
    const connected = snap.exchanges.some(e => e.connected);
    dotEl.classList.toggle('connected', connected);
  }
});
priceTracker.start();

// 초기 렌더링
renderDashboard();

// Dev 패널 마운트 (프로덕션에서 완전 제거됨)
if (import.meta.env.DEV) {
  import('../dev-only/panel').then((mod) => {
    const container = document.querySelector('.container');
    if (container) mod.mountDevPanel(container as HTMLElement);
  });
}
