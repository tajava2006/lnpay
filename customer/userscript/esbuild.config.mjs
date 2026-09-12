import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = process.env.SAJWO_DEV === 'true';

/**
 * 빌드 시각 기반 버전 (UTC, YYYY.MM.DD.HHMM).
 *
 * Tampermonkey는 @version이 커져야만 자동 업데이트를 적용한다.
 * 예전 배너는 1.0.0 고정이라 상수가 바뀌어도 설치본이 영영 갱신되지
 * 않았다 — APP_PUBKEY 교체(2026-09-03)가 6주 넘게 반영 안 된 원인.
 * 시각 기반이면 빌드할 때마다 단조 증가가 보장된다.
 */
function buildVersion() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return [
    d.getUTCFullYear(),
    p(d.getUTCMonth() + 1),
    p(d.getUTCDate()),
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`,
  ].join('.');
}

/**
 * 자동 업데이트를 받아올 절대 URL (상대 경로는 쓸 수 없다).
 *
 * 유저스크립트는 고객앱의 public/에서 그대로 서빙된다.
 * http는 301로 https에 넘기므로 평문 홉이 없는 https를 직접 박는다 —
 * 이 URL로 받은 코드는 쿠팡 페이지에서 GM 저장소(nsec 포함) 권한을 갖고
 * 실행되므로 중간자 개입 여지를 남기지 않는다.
 *
 * 도메인을 옮기면 여기만 고치면 된다. 환경변수로 덮어쓸 수도 있다.
 */
const DEFAULT_UPDATE_URL = 'https://customer.hoppe-relay.it.com/sajwo-coupang-parser.user.js';
const updateUrl = process.env.SAJWO_USERSCRIPT_URL ?? DEFAULT_UPDATE_URL;

const version = buildVersion();

let banner = readFileSync(resolve(__dirname, 'banner.txt'), 'utf-8')
  .replace('%%VERSION%%', version);

if (updateUrl) {
  banner = banner.split('%%UPDATE_URL%%').join(updateUrl);
} else {
  // URL을 모르면 헤더를 넣지 않는다. 플레이스홀더가 그대로 박히면
  // Tampermonkey가 쓰레기 URL을 물고 매번 업데이트에 실패한다.
  banner = banner
    .split('\n')
    .filter((line) => !line.includes('%%UPDATE_URL%%'))
    .join('\n');
}

await build({
  entryPoints: [resolve(__dirname, 'src/main.ts')],
  bundle: true,
  minify: !isDev,
  format: 'iife',
  target: 'es2020',
  outfile: resolve(__dirname, '../public/sajwo-coupang-parser.user.js'),
  banner: { js: banner },
  define: {
    'import.meta.env.DEV': isDev ? 'true' : 'false',
    'import.meta.env.VITE_NOSTR_SINCE': 'undefined',
    '__USERSCRIPT_VERSION__': JSON.stringify(version),
  },
  logLevel: 'info',
});

console.log(`  mode:    ${isDev ? 'dev (sajwo-tracker-dev)' : 'prod (sajwo-tracker)'}`);
console.log(`  version: ${version}`);
if (updateUrl) {
  console.log(`  update:  ${updateUrl}`);
} else {
  console.warn(
    '  update:  (없음) — SAJWO_USERSCRIPT_URL 미설정이라 자동 업데이트가 꺼진 빌드입니다.\n'
    + '           설치본이 이 빌드에 영구히 고정되므로, 배포 빌드에서는 반드시 설정하세요.',
  );
}
