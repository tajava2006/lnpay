import { defineConfig } from 'vitest/config';

// 온체인 클라이언트 로직(키 파생·주소 검증·서명)을 돌린다.
// localStorage를 쓰는 스토어가 있어 happy-dom이 필요하다.
export default defineConfig({
  test: {
    environment: 'happy-dom',
  },
});
