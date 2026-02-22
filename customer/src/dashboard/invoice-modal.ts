/**
 * Lightning 인보이스 모달
 *
 * bolt11 인보이스를 QR 코드 + 복사 버튼으로 표시한다.
 * 닫기: × 버튼, backdrop 클릭, ESC 키.
 */
import QRCode from 'qrcode';

const MODAL_ID = 'invoiceModalOverlay';

let styleInjected = false;

function injectStyle(): void {
  if (styleInjected) return;
  styleInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    .invoice-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 999;
    }
    .invoice-modal {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      border-radius: 16px;
      padding: 32px;
      max-width: 400px;
      width: 90%;
      z-index: 1000;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      animation: invoiceModalIn 0.3s ease-out;
    }
    @keyframes invoiceModalIn {
      from { transform: translate(-50%, -50%) scale(0.9); opacity: 0; }
      to { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    }
    .invoice-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .invoice-modal-header h3 {
      margin: 0;
      font-size: 20px;
      color: #333;
    }
    .invoice-modal-close {
      background: none;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: #999;
      padding: 0 4px;
    }
    .invoice-modal-close:hover { color: #333; }
    .invoice-modal-body { text-align: center; }
    .invoice-modal-order {
      font-size: 14px;
      color: #666;
      margin: 0 0 16px;
    }
    .invoice-modal-qr {
      display: flex;
      justify-content: center;
      margin-bottom: 16px;
    }
    .invoice-modal-qr svg {
      border-radius: 8px;
      border: 2px solid #eee;
    }
    .invoice-modal-hint {
      font-size: 13px;
      color: #999;
      margin: 0 0 16px;
    }
    .invoice-modal-bolt11 {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #f8f9fa;
      border-radius: 8px;
      padding: 10px 12px;
    }
    .invoice-bolt11-text {
      flex: 1;
      font-size: 12px;
      color: #666;
      word-break: break-all;
      text-align: left;
      font-family: monospace;
    }
    .invoice-btn-copy {
      background: #4F46E5;
      color: white;
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.2s;
    }
    .invoice-btn-copy:hover { background: #4338CA; }
  `;
  document.head.appendChild(style);
}

/**
 * bolt11 인보이스 모달을 표시한다.
 */
export async function showInvoiceModal(orderId: string, bolt11: string): Promise<void> {
  closeInvoiceModal();
  injectStyle();

  const overlay = document.createElement('div');
  overlay.id = MODAL_ID;

  // QR 코드 SVG 생성 (lightning: URI 형식)
  let qrSvg: string;
  try {
    qrSvg = await QRCode.toString(`lightning:${bolt11}`, {
      type: 'svg',
      width: 280,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    });
  } catch {
    qrSvg = '<div style="padding:20px;color:#999;">QR 생성 실패</div>';
  }

  // bolt11 말줄임 표시
  const truncated = bolt11.length > 40
    ? `${bolt11.slice(0, 20)}...${bolt11.slice(-10)}`
    : bolt11;

  overlay.innerHTML = `
    <div class="invoice-modal-backdrop"></div>
    <div class="invoice-modal">
      <div class="invoice-modal-header">
        <h3>Lightning 결제</h3>
        <button class="invoice-modal-close" id="invoiceModalClose">&times;</button>
      </div>
      <div class="invoice-modal-body">
        <p class="invoice-modal-order">주문 #${orderId}</p>
        <div class="invoice-modal-qr">${qrSvg}</div>
        <p class="invoice-modal-hint">QR 코드를 Lightning 지갑으로 스캔하세요</p>
        <div class="invoice-modal-bolt11">
          <code class="invoice-bolt11-text">${truncated}</code>
          <button class="invoice-btn-copy" id="invoiceCopyBtn">복사</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // 닫기 버튼
  document.getElementById('invoiceModalClose')?.addEventListener('click', closeInvoiceModal);

  // backdrop 클릭으로 닫기
  overlay.querySelector('.invoice-modal-backdrop')?.addEventListener('click', closeInvoiceModal);

  // 복사 버튼
  document.getElementById('invoiceCopyBtn')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(bolt11);
      const btn = document.getElementById('invoiceCopyBtn');
      if (btn) {
        btn.textContent = '복사됨!';
        setTimeout(() => { if (btn) btn.textContent = '복사'; }, 2000);
      }
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = bolt11;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  });

  // ESC 키로 닫기
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeInvoiceModal();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

export function closeInvoiceModal(): void {
  document.getElementById(MODAL_ID)?.remove();
}
