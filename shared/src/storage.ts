import type { StorageAdapter } from './types';

/** localStorage 기반 StorageAdapter (웹앱용: customer, sponsor, admin) */
export function createWebStorage(): StorageAdapter {
  return {
    async get<T>(key: string): Promise<T | null> {
      const stored = localStorage.getItem(key);
      if (!stored) return null;
      try {
        return JSON.parse(stored) as T;
      } catch {
        return null;
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      localStorage.setItem(key, JSON.stringify(value));
    },
  };
}

/** localStorage 기반 StorageAdapter 싱글턴 */
export const storage = createWebStorage();
