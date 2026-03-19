/**
 * NIP-78 LN 설정 구독 서비스
 *
 * startAdminSubscription()과 동일한 생명주기 패턴으로,
 * 앱 시작 시 즉시 구독을 열어 암호화된 LN 설정을 수신한다.
 */
import { getWriteRelays, storage } from '@sajwo-tracker/shared';
import { subscribeLnConfig, decryptLnConfig } from './ln-config';

export { decryptLnConfig } from './ln-config';

let cleanup: (() => void) | null = null;
/** async 경쟁 조건 방어용 세대 카운터 */
let generation = 0;

/**
 * NIP-78 LN 설정 구독을 시작한다.
 * 수신된 암호화 content를 onEncrypted 콜백으로 전달한다.
 */
export async function startLnConfigSubscription(
  onEncrypted: (content: string) => void,
): Promise<void> {
  if (cleanup) return;

  const gen = ++generation;

  const relays = await getWriteRelays(storage);

  // await 사이에 stop이 호출됐으면 구독하지 않음
  if (gen !== generation) return;

  cleanup = subscribeLnConfig(relays, (event) => {
    if (event.content) {
      onEncrypted(event.content);
    }
  });
}

export function stopLnConfigSubscription(): void {
  generation++;           // 진행 중인 async start를 무효화
  cleanup?.();
  cleanup = null;
}
