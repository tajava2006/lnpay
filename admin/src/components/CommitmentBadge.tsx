import { useEffect, useState } from 'react';
import { verifyAccountCommitment } from '@sajwo-tracker/shared';
import type { AccountInfo } from '@sajwo-tracker/shared';

interface Props {
  accountInfo: AccountInfo;
  commitment: string;
  /** 후원자가 함께 공개한 솔트. 솔트 도입 이전 기록이면 없다. */
  salt?: string;
}

/**
 * account-reveal 메시지의 커밋먼트 검증 배지.
 *
 * 공식은 shared/account-commitment에만 있다 — 고객이 만들고 여기서 검증하므로
 * 양쪽이 갈리면 안 된다.
 */
export function CommitmentBadge({ accountInfo, commitment, salt }: Props) {
  const [verified, setVerified] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void verifyAccountCommitment(accountInfo, commitment, salt).then(ok => {
      if (!cancelled) setVerified(ok);
    });
    return () => { cancelled = true; };
  }, [accountInfo, commitment, salt]);

  if (verified === null) return null;

  if (verified) {
    return (
      <div style={{ fontSize: 11, fontWeight: 600, color: '#059669', marginTop: 4 }}>
        &#x2713; 커밋먼트 검증 완료{!salt && ' (구 방식)'}
      </div>
    );
  }
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: '#DC2626', marginTop: 4 }}>
      &#x26A0; 커밋먼트 불일치
    </div>
  );
}
