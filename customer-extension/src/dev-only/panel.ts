/**
 * [DEV ONLY] 테스트 도구 패널
 *
 * 대시보드 하단에 삽입되어 쿠팡 자동감지를 대체하는 최소한의 테스트 기능을 제공한다.
 * - 테스트 주문 생성 (쿠팡 데이터 없이 가짜 주문 생성)
 *
 * 상태 변경(결제/취소 등)은 실제 Admin 앱을 통해 테스트한다.
 * Dev/Prod 환경이 t태그 + since 필터로 격리되어 있으므로
 * Admin 앱을 그대로 사용하는 것이 프로덕션에 가장 가까운 테스트이다.
 *
 * 이 파일은 import.meta.env.DEV 가드 내부에서만 import되며
 * 프로덕션 빌드에서 완전히 제거된다.
 */

import { createOrder } from '../shared/storage';
import { generateTestOrderData, type TestOrderParams } from './test-data';

/**
 * Dev 패널을 대시보드 DOM에 삽입한다.
 */
export function mountDevPanel(container: HTMLElement): void {
  const panel = document.createElement('div');
  panel.id = 'devPanel';
  panel.innerHTML = buildPanelHTML();
  container.appendChild(panel);

  bindCreateOrder(panel);
}

// ============================================================
// 내부 구현
// ============================================================

function buildPanelHTML(): string {
  return `
    <div style="
      margin-top: 32px;
      padding: 24px;
      background: #FFF7ED;
      border: 2px dashed #F97316;
      border-radius: 12px;
    ">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 20px;">
        <span style="
          background: #F97316;
          color: white;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 600;
        ">DEV</span>
        <h2 style="margin: 0; font-size: 18px; color: #9A3412;">테스트 도구</h2>
      </div>

      <!-- 테스트 주문 생성 -->
      <div>
        <h3 style="font-size: 14px; color: #666; margin: 0 0 8px 0;">테스트 주문 생성</h3>
        <div style="display: flex; gap: 8px; align-items: end; flex-wrap: wrap;">
          <label style="font-size: 12px; color: #666;">
            금액 (원)
            <input type="number" id="devTestPrice" placeholder="랜덤"
              style="display: block; width: 120px; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; margin-top: 2px;" />
          </label>
          <label style="font-size: 12px; color: #666;">
            만료 (초)
            <input type="number" id="devTestExpiration" placeholder="랜덤"
              style="display: block; width: 120px; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; margin-top: 2px;" />
          </label>
          <button id="devCreateOrder" class="btn btn-publish" style="height: 34px;">
            + 테스트 주문
          </button>
        </div>
      </div>
    </div>
  `;
}

function devLog(message: string): void {
  console.log(`[DevPanel] ${message}`);
}

function bindCreateOrder(panel: HTMLElement): void {
  const btn = panel.querySelector('#devCreateOrder') as HTMLButtonElement;
  btn.addEventListener('click', async () => {
    const priceInput = panel.querySelector('#devTestPrice') as HTMLInputElement;
    const expInput = panel.querySelector('#devTestExpiration') as HTMLInputElement;

    const params: TestOrderParams = {};
    if (priceInput.value) params.price = Number(priceInput.value);
    if (expInput.value) params.expirationSeconds = Number(expInput.value);

    const testData = generateTestOrderData(params);
    devLog(`주문 생성 중... orderId=${testData.orderId}, price=${testData.amount.toLocaleString()}`);

    try {
      const order = await createOrder(testData);
      devLog(`주문 생성 완료: ${order.orderId} (${order.productName})`);
    } catch (err) {
      devLog(`주문 생성 실패: ${String(err)}`);
    }
  });
}
