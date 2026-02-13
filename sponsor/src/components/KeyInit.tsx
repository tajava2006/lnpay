import { useEffect, useState, type ReactNode } from 'react';
import { ensureKeypair } from '../nostr/keys';

interface Props {
  children: ReactNode;
}

/**
 * 앱 진입 시 Nostr 키페어를 보장하는 래퍼 컴포넌트.
 * 유저에게는 Nostr 관련 UI를 전혀 노출하지 않는다.
 */
export function KeyInit({ children }: Props) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    ensureKeypair();
    setReady(true);
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
