import { defineConfig } from 'vitest/config';

// legacy/ 는 데몬으로 옮기기 전(P4) 잠시 세워 둔 옛 온체인 코드다 — 컴파일도 테스트도 안 한다.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
