import { useEffect, useState } from 'react';
import { sha256Hex } from '@sajwo-tracker/shared';
import type { AccountInfo } from '@sajwo-tracker/shared';

/** account-reveal 메시지의 커밋먼트 검증 배지 */
export function CommitmentBadge({ accountInfo, commitment }: { accountInfo: AccountInfo; commitment: string }) {
  const [verified, setVerified] = useState<boolean | null>(null);

  useEffect(() => {
    void sha256Hex(JSON.stringify(accountInfo)).then(hash => {
      setVerified(hash === commitment);
    });
  }, [accountInfo, commitment]);

  if (verified === null) return null;
  if (verified) {
    return (
      <div style={{ fontSize: 11, fontWeight: 600, color: '#059669', marginTop: 4 }}>
        &#x2713; 커밋먼트 검증 완료
      </div>
    );
  }
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: '#DC2626', marginTop: 4 }}>
      &#x26A0; 커밋먼트 불일치
    </div>
  );
}
