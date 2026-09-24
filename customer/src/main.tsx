import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Maintenance } from './Maintenance';

/**
 * 공사 중 (2026-09-24~) — 어드민을 롱러닝 데몬으로 옮기는 동안 유저 앱을 닫아 둔다.
 *
 * 프로덕션 빌드에서만 닫는다. 개발 서버에서는 앱이 그대로 떠야 데몬 작업을 할 수 있다.
 * 앱은 **동적 import**로 부른다 — 이 값이 true인 빌드에서는 그 분기가 통째로 빠져서
 * 앱 코드가 번들에 아예 안 들어간다(구독·저장소·푸시 등록이 돌 여지가 없다).
 * 다시 열 때 false로.
 *
 * `__LOCAL_OPEN__` — prod 데몬과 로컬에서 실결제 테스트를 하려고 prod 빌드를 여는 스위치
 * (`pnpm preview:customer`). 빌드 때 박히는 상수라 배포 빌드에서는 위 분기 제거가 그대로다.
 */
const MAINTENANCE = true;

const root = createRoot(document.getElementById('root')!);

if (MAINTENANCE && !import.meta.env.DEV && !__LOCAL_OPEN__) {
  root.render(
    <StrictMode>
      <Maintenance />
    </StrictMode>,
  );
} else {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }

  void Promise.all([import('@sajwo-tracker/shared'), import('./App')])
    .then(([{ initIdb, ORDER_DB_NAME }, { App }]) => {
      initIdb(ORDER_DB_NAME);
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });
}
