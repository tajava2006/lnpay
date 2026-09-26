import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

const commitHash = execSync('git rev-parse --short HEAD').toString().trim();

/** 공사 중인 prod 빌드를 로컬에서 열어 보는 빌드 모드 — `pnpm preview:customer`만 쓴다 */
const LOCAL_OPEN_MODE = 'localopen';

/**
 * CSP — 이 앱은 브라우저 저장소에 유저 nsec를 들고 있다. 핵심은 `script-src 'self'`다: 우리 번들 말고는
 * 어떤 스크립트도(인라인·외부·eval) 못 돈다 — 주입된 스크립트 한 줄로 키가 나가는 길을 막는다.
 * VPS가 털려 번들 자체가 바뀌는 경우(RISKS R-2)는 못 막는다.
 *
 * **배포 빌드에만** 싣는다(preview 포함). 개발 서버는 React 새로고침이 인라인 스크립트라 막히면 안 뜬다.
 * 외부 연결을 새로 붙이면 여기 `connect-src`에 더한다 — 빠뜨리면 **조용히 막힌다**(콘솔에만 뜬다).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // index.html의 인라인 <style>. 스타일로는 키를 읽어 갈 수 없다
  "style-src 'self' 'unsafe-inline'",
  // 릴레이는 APP·유저의 릴레이 목록(kind 10002)에서 와서 미리 알 수 없다 → wss 전체.
  // 시세(업비트·빗썸·코인원)도 wss다. 체인 조회는 mempool.space 하나(shared/onchain/chain.ts)
  "connect-src 'self' wss: https://mempool.space",
  "img-src 'self' data: blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'pairbuy-csp',
    apply: 'build',
    transformIndexHtml: () => [{
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
      injectTo: 'head-prepend',
    }],
  };
}

export default defineConfig(({ mode }) => ({
  envDir: '..',
  plugins: [react(), contentSecurityPolicy()],
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
