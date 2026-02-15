import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // '' prefix → VITE_ 아닌 env 변수도 로드 (LN_REST_HOST 등 서버 사이드 전용)
  const env = loadEnv(mode, process.cwd(), '');

  const lnHost = env.LN_REST_HOST;
  const lnBackend = env.VITE_LN_BACKEND as 'lnd' | 'cln' | undefined;
  const macaroon = env.LN_MACAROON_HEX;
  const rune = env.LN_RUNE;

  return {
    plugins: [react()],
    server: {
      port: 5175,
      proxy: lnHost
        ? {
            '/lnapi': {
              target: lnHost,
              changeOrigin: true,
              secure: false,
              rewrite: (path: string) => path.replace(/^\/lnapi/, ''),
              configure: (proxy) => {
                proxy.on('proxyReq', (proxyReq) => {
                  if (lnBackend === 'lnd' && macaroon) {
                    proxyReq.setHeader('Grpc-Metadata-macaroon', macaroon);
                  } else if (lnBackend === 'cln' && rune) {
                    proxyReq.setHeader('Rune', rune);
                  }
                });
              },
            },
          }
        : undefined,
    },
  };
});
