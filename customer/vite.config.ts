import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

const commitHash = execSync('git rev-parse --short HEAD').toString().trim();

export default defineConfig({
  envDir: '..',
  plugins: [react()],
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
    // 공사 중인 prod 빌드를 로컬에서 열어 본다(`pnpm preview:customer`만 켠다). 배포 빌드(`ship`)에는 없어서
    // 거기서는 앱 코드가 번들에서 통째로 빠진다
    __LOCAL_OPEN__: JSON.stringify(process.env.LNPAY_LOCAL_OPEN === '1'),
  },
  server: {
    port: 5173,
  },
  // 포트가 곧 오리진이고 오리진마다 localStorage(=유저 키)가 따로다 — 밀려서 다른 포트로 뜨면 다른 사람이 된다
  preview: {
    port: 4174,
    strictPort: true,
  },
});
