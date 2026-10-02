import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { createAppStore } from './state/store';

const { store } = createAppStore();
void store.init();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);

// Offline shell (A2): the app itself is cached so it opens without a network.
// Market data never goes through the service worker — it lives in IndexedDB
// behind the TTL cache and is always labelled stale/fresh (U2).
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // registration failure is non-fatal: the app still runs online
    });
  });
}
