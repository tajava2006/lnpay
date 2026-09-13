import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { execSync } from 'child_process';

const commitHash = execSync('git rev-parse --short HEAD').toString().trim();

export default defineConfig({
  envDir: '..',
  plugins: [
    react(),
    nodePolyfills({ include: ['buffer', 'stream', 'events'] }),
  ],
  build: {
    // admin은 운영자 본인만 쓰는 도구다. bolt11(bitcoinjs-lib, secp256k1, bn.js를
    // 끌고 온다)이 유동성 프로빙에 필요해 덩치가 크지만, 데스크탑에서 한 번 받아
    // 캐시되는 용도라 문제가 아니다. 기본 500KB 경고가 매 빌드마다 떠 있으면
    // 출력을 안 읽게 되므로, 지금 크기보다 여유 있게 올려 **실제로 확 늘었을 때만**
    // 다시 눈에 띄게 한다. (사용자용 앱은 별개 — 거기는 실제로 줄였다, 감사 C-4)
    chunkSizeWarningLimit: 1100,
  },
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  server: {
    port: 5175,
  },
});
