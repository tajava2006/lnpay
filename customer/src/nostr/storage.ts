import type { StorageAdapter } from '@sajwo-tracker/shared';

/** chrome.storage.local 기반 StorageAdapter */
export const storage: StorageAdapter = {
  async get<T>(key: string): Promise<T | null> {
    const result = await chrome.storage.local.get(key);
    return (result[key] as T) ?? null;
  },
  async set<T>(key: string, value: T): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
};
