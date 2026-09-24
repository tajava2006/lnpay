import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

const commitHash = execSync('git rev-parse --short HEAD').toString().trim();

/** 공사 중인 prod 빌드를 로컬에서 열어 보는 빌드 모드 — `pnpm preview:customer`만 쓴다 */
const LOCAL_OPEN_MODE = 'localopen';

export default defineConfig(({ mode }) => ({
  envDir: '..',
  plugins: [react()],
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
    // 배포 빌드(`ship`)는 기본 모드라 false — 거기서는 앱 코드가 번들에서 통째로 빠진다. 예전엔 환경변수로
    // 켰다 — 운영 PC에서 로컬인데도 공사 중 화면이 뜬 적이 있다(2026-09-24, 원인 미확정: 4174를 쥔 옛 preview
    // 서버 가능성이 크다). 환경변수는 셸·중첩 pnpm을 거쳐야 해서 빠질 길이 있고, 모드는 vite 인자라 그 길이 없다
    __LOCAL_OPEN__: JSON.stringify(mode === LOCAL_OPEN_MODE),
  },
  server: {
    port: 5173,
  },
  // 포트가 곧 오리진이고 오리진마다 localStorage(=유저 키)가 따로다 — 밀려서 다른 포트로 뜨면 다른 사람이 된다
  preview: {
    port: 4174,
    strictPort: true,
  },
}));
