/**
 * [DEV ONLY] 테스트 도구 패널
 *
 * 대시보드 하단에 삽입되어 쿠팡 자동감지를 대체하는 최소한의 테스트 기능을 제공한다.
 * 1. 테스트 주문 생성 (쿠팡 데이터 없이 가짜 주문 생성)
 * 2. 결제/취소 수동 처리 (Admin 상태 시뮬레이션)
 *
 * 이 파일은 import.meta.env.DEV 가드 내부에서만 import되며
 * 프로덕션 빌드에서 완전히 제거된다.
 */

import { createOrder, getOrder, saveOrder } from '../shared/storage';
import { getDisplayMeta, isFinal } from '../shared/order-states';
import type { TrackedOrder } from '../shared/types';
import type { OrderState } from '@sajwo-tracker/shared';
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
  bindImportRawEvent(panel);
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
    if (isFinal(order)) continue; // 최종 상태는 제외
    const meta = getDisplayMeta(order);
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

      <!-- Admin 상태 시뮬레이션 -->
      <div style="margin-bottom: 20px;">
        <h3 style="font-size: 14px; color: #666; margin: 0 0 8px 0;">Admin 상태 시뮬레이션</h3>
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

      <!-- Raw 이벤트로 주문 복원 -->
      <div style="margin-bottom: 20px;">
        <h3 style="font-size: 14px; color: #666; margin: 0 0 8px 0;">Nostr 이벤트로 주문 복원</h3>
        <textarea id="devRawEventInput" placeholder='{"id":"...","pubkey":"...","kind":1111,"tags":[...],...}'
          style="display: block; width: 100%; height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace; font-size: 11px; resize: vertical; margin-bottom: 8px;"></textarea>
        <button id="devImportRawEvent" class="btn btn-publish" style="height: 34px;">
          주문 복원
        </button>
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
  btn.addEventListener('click', () => handleAdminStateSimulation('paid', btn));
}

function bindCancelAction(panel: HTMLElement): void {
  const btn = panel.querySelector('#devMarkCancelled') as HTMLButtonElement;
  btn.addEventListener('click', () => handleAdminStateSimulation('cancelled', btn));
}

function bindImportRawEvent(panel: HTMLElement): void {
  const btn = panel.querySelector('#devImportRawEvent') as HTMLButtonElement;
  btn.addEventListener('click', async () => {
    const textarea = panel.querySelector('#devRawEventInput') as HTMLTextAreaElement;
    const raw = textarea.value.trim();
    if (!raw) {
      devLog('이벤트 JSON을 입력해주세요.');
      return;
    }

    try {
      const event = JSON.parse(raw);
      const tags: string[][] = event.tags ?? [];

      // kind 1111에서는 a-tag에서 orderId 추출, kind 30402에서는 d-tag
      let orderId: string | undefined;
      const aTag = tags.find((t: string[]) => t[0] === 'a')?.[1];
      if (aTag) {
        orderId = aTag.split(':')[2];
      }
      if (!orderId) {
        orderId = tags.find((t: string[]) => t[0] === 'd')?.[1];
      }
      if (!orderId) {
        devLog('orderId를 찾을 수 없습니다 (a-tag 또는 d-tag).');
        return;
      }

      const priceStr = tags.find((t: string[]) => t[0] === 'price')?.[1];
      const price = priceStr ? Number(priceStr) : 0;

      const expStr = tags.find((t: string[]) => t[0] === 'expiration')?.[1];
      const expirationDate = expStr ? Number(expStr) * 1000 : Date.now() + 86400_000;

      const stateTag = tags.find((t: string[]) => t[0] === 'state')?.[1] as OrderState | undefined;

      const order: TrackedOrder = {
        orderId,
        productName: '복원된 주문',
        amount: price,
        createdAt: (event.created_at ?? Math.floor(Date.now() / 1000)) * 1000,
        adminState: stateTag,
        virtualAccount: {
          bankName: '(복원)',
          bankCode: 'XXXX',
          accountNumber: '000-0000-0000-00',
          depositor: '(복원)',
          depositPrice: price,
          expirationDate,
        },
        raw,
      };

      await saveOrder(order);
      devLog(`주문 복원 완료: ${orderId} (adminState=${stateTag ?? 'none'}, price=${price.toLocaleString()})`);
      textarea.value = '';
    } catch (err) {
      devLog(`주문 복원 실패: ${String(err)}`);
    }
  });
}

/**
 * Admin 상태를 직접 설정하여 시뮬레이션한다.
 * 실제 환경에서는 Admin이 kind 30402를 발행하고 구독에서 수신하지만,
 * Dev 환경에서는 Admin이 없으므로 로컬 스토리지에 직접 반영한다.
 */
async function handleAdminStateSimulation(
  adminState: OrderState,
  btn: HTMLButtonElement,
): Promise<void> {
  const select = document.getElementById('devOrderSelect') as HTMLSelectElement;
  const orderId = select.value;
  if (!orderId) {
    devLog('주문을 선택해주세요.');
    return;
  }

  const label = adminState === 'paid' ? '결제 완료' : '취소';
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '처리 중...';

  devLog(`${label} 시뮬레이션: ${orderId}`);

  try {
    const order = await getOrder(orderId);
    if (!order) {
      devLog(`주문을 찾을 수 없습니다: ${orderId}`);
      return;
    }

    await saveOrder({ ...order, adminState });
    devLog(`${label} 완료: ${orderId} (adminState=${adminState})`);
  } catch (err) {
    devLog(`${label} 처리 오류: ${String(err)}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
