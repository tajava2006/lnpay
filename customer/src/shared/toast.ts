/**
 * 토스트 알림 유틸리티
 *
 * popup과 dashboard 양쪽에서 사용하는 공통 토스트.
 * slide-in 등장 → 자동 fade-out 사라짐.
 */

export interface ToastOptions {
  title: string;
  message: string;
  /** 자동 사라짐 시간 (ms). 기본값: 5000 */
  duration?: number;
  /** 클릭 시 콜백 */
  onClick?: () => void;
}

let styleInjected = false;

function injectStyle(): void {
  if (styleInjected) return;
  styleInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    .sajwo-toast {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 10000;
      animation: sajwoSlideIn 0.4s ease-out;
    }
    .sajwo-toast-inner {
      display: flex;
      align-items: center;
      gap: 12px;
      background: linear-gradient(135deg, #F59E0B 0%, #EF4444 100%);
      color: white;
      padding: 14px 20px;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
      max-width: 320px;
    }
    .sajwo-toast-icon { font-size: 24px; }
    .sajwo-toast-title { font-size: 14px; font-weight: 700; }
    .sajwo-toast-message { font-size: 12px; opacity: 0.9; margin-top: 2px; }
    @keyframes sajwoSlideIn {
      from { transform: translateX(120%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes sajwoSlideOut {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(120%); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

export function showToast(options: ToastOptions): void {
  const { title, message, duration = 5000, onClick } = options;

  injectStyle();

  const container = document.createElement('div');
  container.className = 'sajwo-toast';
  container.innerHTML = `
    <div class="sajwo-toast-inner">
      <div class="sajwo-toast-icon">&#9889;</div>
      <div class="sajwo-toast-content">
        <div class="sajwo-toast-title">${title}</div>
        <div class="sajwo-toast-message">${message}</div>
      </div>
    </div>
  `;

  if (onClick) {
    container.style.cursor = 'pointer';
    container.addEventListener('click', () => {
      container.remove();
      onClick();
    });
  }

  document.body.appendChild(container);

  setTimeout(() => {
    container.style.animation = 'sajwoSlideOut 0.5s ease-in forwards';
    container.addEventListener('animationend', () => container.remove());
  }, duration);
}
