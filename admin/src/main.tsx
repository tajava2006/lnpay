import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { clearLegacyStorage } from './legacy-storage';

clearLegacyStorage();

if ('serviceWorker' in navigator) {
  // 등록 실패(사생활 모드·비보안 출처)는 앱을 막지 않는다 — 푸시만 못 쓴다
  navigator.serviceWorker.register('/sw.js').catch((e: unknown) => console.warn('[SW] 등록 실패', e));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
