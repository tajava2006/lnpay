import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initIdb, ORDER_DB_NAME } from '@sajwo-tracker/shared';
import { App } from './App';

initIdb(ORDER_DB_NAME);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
