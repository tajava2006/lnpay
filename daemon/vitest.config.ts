import { defineConfig } from 'vitest/config';

// 데몬은 Node 프로세스다 — DOM 없이 node 환경으로 돈다(`node:sqlite` 포함).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
