import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import type { Connect } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const secretKey = env.APP_SECRET_KEY;

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
      nodePolyfills({ include: ['buffer', 'stream', 'events'] }),
      {
        name: 'admin-config',
        configureServer(server) {
          server.middlewares.use(adminConfigMiddleware);
        },
      },
    ],
    server: {
      port: 5175,
    },
  };
});
