import { defineConfig } from 'vite';

// 후원자앱은 고객앱과 합쳐졌다. 정적 안내/리다이렉트 페이지만 빌드한다.
export default defineConfig({
  server: { port: 5174 },
});
