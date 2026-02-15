/**
 * [DEV ONLY] 테스트 도구 패널
 *
 * 대시보드 하단에 삽입되어 쿠팡 자동감지를 대체하는 최소한의 테스트 기능을 제공한다.
 * 1. 테스트 주문 생성 (쿠팡 데이터 없이 가짜 주문 생성)
 * 2. 결제/취소 수동 처리 (은행 자동감지 불가 대체)
 *
 * 이 파일은 import.meta.env.DEV 가드 내부에서만 import되며
 * 프로덕션 빌드에서 완전히 제거된다.
 */

import { createOrder } from '../shared/storage';
import { transitionOrderWithRetry } from '../shared/state-machine';
import { getStatusMeta, isFinalStatus } from '../shared/order-states';
import type { TrackedOrder } from '../shared/types';
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
  bindPaidAction(panel);
  bindCancelAction(panel);
}

/**
 * 주문 목록 변경 시 드롭다운을 갱신한다.
 * 대시보드 renderDashboard()에서 호출.
 */
export function refreshOrderSelect(orders: Record<string, TrackedOrder>): void {
  const select = document.getElementById('devOrderSelect') as HTMLSelectElement | null;
  if (!select) return;

  const currentValue = select.value;
  select.innerHTML = '<option value="">주문 선택...</option>';

  for (const order of Object.values(orders)) {
    if (isFinalStatus(order.status)) continue; // 최종 상태는 제외
    const meta = getStatusMeta(order.status);
    const opt = document.createElement('option');
    opt.value = order.orderId;
    opt.textContent = `${order.orderId} — ${meta.label} (${order.productName})`;
    select.appendChild(opt);
  }

  if (currentValue) select.value = currentValue;
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
      <div style="margin-bottom: 20px;">
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

      <!-- 결제/취소 수동 처리 -->
      <div style="margin-bottom: 20px;">
        <h3 style="font-size: 14px; color: #666; margin: 0 0 8px 0;">결제/취소 수동 처리</h3>
        <div style="display: flex; gap: 8px; align-items: end; flex-wrap: wrap;">
          <label style="font-size: 12px; color: #666;">
            대상 주문
            <select id="devOrderSelect"
              style="display: block; width: 280px; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; margin-top: 2px;">
              <option value="">주문 선택...</option>
            </select>
          </label>
          <button id="devMarkPaid" class="btn btn-publish" style="height: 34px;">
            결제 완료
          </button>
          <button id="devMarkCancelled" class="btn btn-danger" style="height: 34px;">
            취소
          </button>
        </div>
      </div>

      <!-- 로그 -->
      <div>
        <h3 style="font-size: 14px; color: #666; margin: 0 0 8px 0;">로그</h3>
        <div id="devLog" style="
          background: #1a1a2e;
          color: #0f0;
          font-family: monospace;
          font-size: 11px;
          padding: 12px;
          border-radius: 6px;
          max-height: 160px;
          overflow-y: auto;
          white-space: pre-wrap;
        "></div>
      </div>
    </div>
  `;
}

function devLog(message: string): void {
  const log = document.getElementById('devLog');
  if (!log) return;
  const time = new Date().toLocaleTimeString('ko-KR');
  log.textContent += `[${time}] ${message}\n`;
  log.scrollTop = log.scrollHeight;
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

function bindPaidAction(panel: HTMLElement): void {
  const btn = panel.querySelector('#devMarkPaid') as HTMLButtonElement;
  btn.addEventListener('click', () => handleFinalTransition('paid', btn));
}

function bindCancelAction(panel: HTMLElement): void {
  const btn = panel.querySelector('#devMarkCancelled') as HTMLButtonElement;
  btn.addEventListener('click', () => handleFinalTransition('cancelled', btn));
}

/**
 * 결제 완료 / 취소 처리.
 * content/index.ts의 isPaid/isCancelled 감지 후 처리와 동일한 코드 경로:
 *   1. transitionOrderWithRetry(orderId, status)
 *   2. chrome.runtime.sendMessage({ type: 'PUBLISH_ORDER', orderId })
 */
async function handleFinalTransition(
  toStatus: 'paid' | 'cancelled',
  btn: HTMLButtonElement,
): Promise<void> {
  const select = document.getElementById('devOrderSelect') as HTMLSelectElement;
  const orderId = select.value;
  if (!orderId) {
    devLog('주문을 선택해주세요.');
    return;
  }

  const label = toStatus === 'paid' ? '결제 완료' : '취소';
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '처리 중...';

  devLog(`${label} 처리 중: ${orderId}`);

  try {
    // 1. 상태 전이 (content script와 동일)
    const result = await transitionOrderWithRetry(orderId, toStatus);
    if (!result.success) {
      devLog(`${label} 전이 실패: ${result.error.type}`);
      return;
    }
    devLog(`${label} 전이 완료: ${orderId}`);

    // 2. Nostr 재발행 (content script와 동일: PUBLISH_ORDER → sold 상태로 발행)
    const publishResult = await chrome.runtime.sendMessage({
      type: 'PUBLISH_ORDER',
      orderId,
    });

    if (publishResult?.success) {
      devLog(`Nostr sold 이벤트 발행 완료: ${orderId}`);
    } else {
      devLog(`Nostr 발행 실패: ${publishResult?.error ?? 'unknown'}`);
    }
  } catch (err) {
    devLog(`${label} 처리 오류: ${String(err)}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
