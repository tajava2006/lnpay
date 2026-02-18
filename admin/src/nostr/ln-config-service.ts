/**
 * NIP-78 LN 설정 구독 서비스
 *
 * startAdminSubscription()과 동일한 생명주기 패턴으로,
 * 앱 시작 시 즉시 구독을 열어 암호화된 LN 설정을 수신한다.
 */
import { getReadRelays } from '@sajwo-tracker/shared';
import { storage } from './storage';
import { subscribeLnConfig, decryptLnConfig } from './ln-config';

export { decryptLnConfig } from './ln-config';

let cleanup: (() => void) | null = null;

/**
 * NIP-78 LN 설정 구독을 시작한다.
 * 수신된 암호화 content를 onEncrypted 콜백으로 전달한다.
 */
export async function startLnConfigSubscription(
  onEncrypted: (content: string) => void,
): Promise<void> {
  if (cleanup) return;

  const relays = await getReadRelays(storage);

  cleanup = subscribeLnConfig(relays, (event) => {
    if (event.content) {
      onEncrypted(event.content);
    }
  });
}

export function stopLnConfigSubscription(): void {
  cleanup?.();
  cleanup = null;
}
