import { useEffect, useState, type ReactNode } from 'react';
import { ensureKeypair } from '../keys';
import { storage } from '../storage';

interface Props {
  children: ReactNode;
}

/**
 * 앱 진입 시 Nostr 키페어를 보장하는 래퍼 컴포넌트.
 * 키가 준비되면 children을 렌더한다.
 *
 * 준비가 실패하면(사생활 모드·저장소 차단으로 키를 못 쓰면) 이유를 보여준다 — 예전엔 "로딩 중"에 영영 멈췄다.
 */
export function KeyInit({ children }: Props) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    ensureKeypair(storage).then(
      () => setReady(true),
      (e: unknown) => {
        console.error('[키] 준비 실패', e);
        setFailed(true);
      },
    );
  }, []);

  if (!ready) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', padding: 16 }}>
        <p style={{ color: failed ? '#991B1B' : '#666', fontSize: 14, textAlign: 'center' }}>
          {failed
            ? '키를 준비하지 못했습니다. 사생활 보호 모드이거나 이 사이트의 저장소가 막혀 있는지 확인하세요.'
            : '로딩 중...'}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
