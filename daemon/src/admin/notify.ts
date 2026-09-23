/**
 * 운영자 DM (NIP-17) — 사람이 봐야 할 일이 생겼을 때 폰의 nostr 클라이언트로 울린다.
 *
 * 봉투는 **쌓을 때 한 번** 만든다. gift wrap은 임시 키·흩뜨린 시각으로 매번 새로 만들어지므로, 재시도
 * 때 다시 만들면 한 알림이 여러 통으로 갈 수 있다. 만든 봉투를 발행 효과에 넣으면 재시도가 같은 id다.
 *
 * ⚠️ 데몬 릴레이로만 보낸다. 운영자 nostr 클라이언트가 그 릴레이를 읽어야 받는다(APP의 kind 10002
 * 목록 — 흔한 공개 릴레이다). 운영자 DM 릴레이(kind 10050) 조회는 필요해지면 붙인다.
 */
import { wrapEvent } from 'nostr-tools/nip17';
import { PUBLISH_EFFECT, type PublishPayload } from '../nostr/publisher';
import type { AdminContext } from './context';

export function notifyOperators(ctx: AdminContext, text: string): void {
  for (const operator of ctx.operators) {
    const wrap = wrapEvent(ctx.appKey.secretKey, { publicKey: operator }, `[페어바이] ${text}`);
    ctx.effects.enqueue<PublishPayload>(PUBLISH_EFFECT, { event: wrap });
  }
}
