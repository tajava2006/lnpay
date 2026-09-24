/**
 * 거래 알림 (NIP-17 비공개 DM)
 *
 * ── 왜 이 방식인가
 *
 * 유저는 신원을 주지 않는다. 그게 이 앱의 전제라 문자·카톡 같은 중앙화 채널은
 * 논외다. 대신 브라우저가 만든 키가 이미 있으니, 그걸로 아무 nostr 클라이언트에
 * 로그인하면 거기로 알림이 간다.
 *
 * NIP-17을 쓰는 이유는 내용과 메타데이터를 둘 다 가리기 때문이다. 거래 알림에는
 * "누가 무엇을 거래 중인가"가 드러나면 안 된다. kind 4는 내용은 가리지만 누가
 * 누구에게 보냈는지가 공개된다.
 *
 * 안드로이드 Amethyst가 NIP-17 알림을 제대로 지원한다. iOS는 지원하는 클라이언트를
 * 찾지 못했고, 근본적으로 애플 푸시 서버를 거쳐야 해서 중앙화 인프라에 의존하게
 * 된다 — 이 앱의 전제와 맞바꿀 값어치가 없다고 보고 안내에서 제외한다.
 *
 * ── 번커로 NIP-17을 만드는 법
 *
 * nostr-tools의 nip17/nip59 함수는 전부 개인키를 직접 받는데, Admin은 NIP-46
 * 원격 서명이라 로컬에 키가 없다. 다행히 봉투 3겹 중 두 겹만 발신자 키가 필요하다:
 *
 *   rumor (kind 14)  — 서명 없음. pubkey와 id만 채우면 된다
 *   seal  (kind 13)  — 발신자가 NIP-44 암호화 + 서명 → **번커 필요**
 *   wrap  (kind 1059) — 임시키로 암호화 + 서명 → 로컬에서 생성 (nip59.createWrap)
 *
 * createWrap이 개인키를 인자로 받지 않고 스스로 임시키를 만들기 때문에 그대로 쓸 수
 * 있다. 결국 손으로 만드는 건 seal 한 겹뿐이고, 그것도 nostr-tools의 참조 구현을
 * 그대로 옮긴 것이다(randomNow 포함 — 타임스탬프를 흩뜨리는 게 NIP-59 요구사항이다).
 */
import { getEventHash } from 'nostr-tools/pure';
import { createWrap } from 'nostr-tools/nip59';
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate, UnsignedEvent } from 'nostr-tools/core';
import { APP_PUBKEY, getReadRelays, storage } from '@sajwo-tracker/shared';
import { getSigner } from './nip46';

const CHAT_KIND = 14;
const SEAL_KIND = 13;
const TWO_DAYS = 2 * 24 * 60 * 60;

/** NIP-59: seal/wrap의 created_at은 최대 이틀 전으로 흩뜨려 타이밍 분석을 막는다. */
function randomNow(): number {
  return Math.round(Math.floor(Date.now() / 1000) - Math.random() * TWO_DAYS);
}

/**
 * 한 사람에게 알림 DM을 보낸다. 실패해도 던지지 않는다 —
 * 알림은 부가 기능이고, 못 보냈다고 거래 진행을 막아선 안 된다.
 */
export async function notify(recipientPubkey: string, message: string): Promise<boolean> {
  const signer = getSigner();
  if (!signer) return false;

  try {
    // ① rumor — 서명하지 않는 원본. 이게 실제 메시지다.
    const rumor: UnsignedEvent & { id: string } = {
      kind: CHAT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: message,
      tags: [['p', recipientPubkey]],
      pubkey: APP_PUBKEY,
      id: '',
    };
    rumor.id = getEventHash(rumor);

    // ② seal — 발신자(Admin)가 수신자에게 NIP-44로 봉인하고 서명한다. 번커가 필요한 유일한 단계.
    const sealTemplate: EventTemplate = {
      kind: SEAL_KIND,
      created_at: randomNow(),
      tags: [],
      content: await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor)),
    };
    const seal = await signer.signEvent(sealTemplate);

    // ③ wrap — 임시키로 한 번 더 감싼다. 발신자가 누구인지 겉에서 안 보이게 된다.
    const wrapped = createWrap(seal, recipientPubkey);

    const relays = await getReadRelays(storage);
    const pool = new SimplePool();
    try {
      const results = await Promise.allSettled(pool.publish(relays, wrapped));
      const ok = results.some(r => r.status === 'fulfilled');
      console.log(ok ? '[알림] 발송:' : '[알림] 발송 실패:', recipientPubkey.slice(0, 8));
      return ok;
    } finally {
      pool.destroy();
    }
  } catch (err) {
    console.warn('[알림] 생성 실패:', recipientPubkey.slice(0, 8), err);
    return false;
  }
}
