import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { Agent } from 'node:https';
import type { Connect } from 'vite';

export default defineConfig(({ mode }) => {
  // '' prefix → VITE_ 아닌 env 변수도 로드 (서버 사이드 전용 변수 포함)
  const env = loadEnv(mode, process.cwd(), '');

  const secretKey = env.APP_SECRET_KEY;
  const lnHost = env.LN_REST_HOST;
  const lnBackend = env.VITE_LN_BACKEND as 'lnd' | 'cln' | undefined;
  const macaroon = env.LN_MACAROON_HEX;
  const rune = env.LN_RUNE;
  const tlsCert = env.LN_TLS_CERT_HEX;  // hex-encoded PEM (tls.cert)

  // TLS 인증서가 제공되면 해당 인증서를 CA로 신뢰하는 에이전트 생성
  // 미제공 시 secure: false로 폴백 (인증서 검증 생략)
  const lnAgent = tlsCert
    ? new Agent({ ca: Buffer.from(tlsCert, 'hex').toString('utf-8') })
    : undefined;

  if (lnHost && !tlsCert) {
    console.warn(
      '\n\x1b[41m\x1b[97m ⚠  WARNING: LN_TLS_CERT_HEX 미설정 — TLS 인증서 검증 비활성 \x1b[0m\n' +
      '\x1b[33m' +
      '  원격 Lightning 노드 연결이 MITM(중간자 공격)에 완전히 무방비 상태입니다.\n' +
      '  공격자가 macaroon/rune을 탈취하면 노드의 자금을 훔칠 수 있으며,\n' +
      '  이 경고를 무시하고 발생한 자금 손실은 전적으로 운영자 책임입니다.\n' +
      '  → LN_TLS_CERT_HEX 설정: xxd -p /path/to/tls.cert | tr -d \'\\n\'\n' +
      '\x1b[0m',
    );
  }

  // Vite dev 서버 전용 미들웨어: 인증 정보를 브라우저에 동적 제공
  // 프로덕션 빌드에는 이 엔드포인트가 존재하지 않으므로 키가 번들에 포함되지 않는다.
  const adminConfigMiddleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url === '/__admin_config') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ secretKey: secretKey || '' }));
      return;
    }
    next();
  };

  return {
    plugins: [
      react(),
      {
        name: 'admin-config',
        configureServer(server) {
          server.middlewares.use(adminConfigMiddleware);
        },
      },
    ],
    server: {
      port: 5175,
      proxy: lnHost
        ? {
            '/lnapi': {
              target: lnHost,
              changeOrigin: true,
              secure: !!lnAgent,
              ...(lnAgent && { agent: lnAgent }),
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
