/**
 * 유저 앱 공용 훅
 */
import { useEffect, useState } from 'react';
import { getUserPubkey, storage } from '@sajwo-tracker/shared';

let pubkeyPromise: Promise<string> | null = null;

/** 내 pubkey — 모르는 동안 null (남의 거래로 단정하지 않는다) */
export function useMyPubkey(): string | null {
  const [pubkey, setPubkey] = useState<string | null>(null);
  useEffect(() => {
    pubkeyPromise ??= getUserPubkey(storage);
    void pubkeyPromise.then(setPubkey);
  }, []);
  return pubkey;
}
