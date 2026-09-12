import { defineConfig } from 'vitest/config';

// shared는 순수 모듈만 테스트한다(커밋먼트, 진행도 모델, 가드 2종).
// DOM이 필요 없고 crypto.subtle / getRandomValues는 Node 런타임에 있으므로
// happy-dom 없이 node 환경이면 충분하다.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
