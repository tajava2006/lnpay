import type { LightningAdapter } from './adapter';
import type { NodeSnapshot } from './types';

const POLL_INTERVAL_MS = 30_000;

export interface NodeTracker {
  start(): void;
  stop(): void;
  /** 수동 재시도 (에러 시 UI에서 호출) */
  refresh(): void;
  /** useSyncExternalStore 용 */
  subscribe(listener: () => void): () => void;
  getSnapshot(): NodeSnapshot;
}

export function createNodeTracker(adapter: LightningAdapter): NodeTracker {
  const listeners = new Set<() => void>();
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let snapshot: NodeSnapshot = {
    status: 'connecting',
    info: null,
    error: null,
    lastCheckedAt: null,
  };

  function notify() {
    snapshot = { ...snapshot };
    for (const listener of listeners) {
      listener();
    }
  }

  async function poll() {
    if (!running) return;

    try {
      const info = await adapter.getInfo();
      snapshot = {
        status: 'connected',
        info,
        error: null,
        lastCheckedAt: Date.now(),
      };
    } catch (err) {
      console.warn('[Lightning] getInfo 실패:', err);
      snapshot = {
        ...snapshot,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    notify();
    schedulePoll();
  }

  function schedulePoll() {
    if (!running) return;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, POLL_INTERVAL_MS);
  }

  return {
    start() {
      if (running) return;
      running = true;
      void poll();
    },

    stop() {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },

    refresh() {
      if (!running) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      void poll();
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot() {
      return snapshot;
    },
  };
}
