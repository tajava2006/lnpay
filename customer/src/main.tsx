import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initIdb } from '@sajwo-tracker/shared';
import { App } from './App';

initIdb('customer-history');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
