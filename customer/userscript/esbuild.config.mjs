import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const banner = readFileSync(resolve(__dirname, 'banner.txt'), 'utf-8');

const isDev = process.env.SAJWO_DEV === 'true';

await build({
  entryPoints: [resolve(__dirname, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: resolve(__dirname, '../public/sajwo-coupang-parser.user.js'),
  banner: { js: banner },
  define: {
    'import.meta.env.DEV': isDev ? 'true' : 'false',
    'import.meta.env.VITE_NOSTR_SINCE': 'undefined',
  },
  logLevel: 'info',
});

console.log(`  mode: ${isDev ? 'dev (sajwo-tracker-dev)' : 'prod (sajwo-tracker)'}`);
