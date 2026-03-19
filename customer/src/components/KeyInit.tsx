import { useEffect, useState, type ReactNode } from 'react';
import { ensureKeypair, storage } from '@sajwo-tracker/shared';

interface Props {
  children: ReactNode;
}

/**
 * 앱 진입 시 Nostr 키페어를 보장하는 래퍼 컴포넌트.
 * 키가 준비되면 children을 렌더한다.
 */
export function KeyInit({ children }: Props) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    ensureKeypair(storage).then(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <p style={{ color: '#666', fontSize: 14 }}>로딩 중...</p>
      </div>
    );
  }

  return <>{children}</>;
}
