/**
 * 데몬을 한 파일로 묶는다.
 *
 * shared가 확장자 없는 import를 쓰고 TS 소스를 그대로 내보내서, 순수 Node로는 바로 못 돌린다.
 * 운영은 이 번들 하나를 `node dist/daemon.mjs`로 돌린다 — 컨테이너에 node_modules가 필요 없다.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/daemon.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  // CJS 의존성이 require를 부를 때를 대비한다 (ESM 번들에는 require가 없다)
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
