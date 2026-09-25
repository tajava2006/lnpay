/**
 * 분쟁 채팅 중계
 *
 * 분쟁 채팅은 APP 키와 유저 사이의 NIP-44다. 운영자 키는 못 읽으므로 데몬이 풀어서 운영자에게 다시
 * 암호화해 보낸다 — 유저가 보낸 것도, 어드민이 보낸 것도(운영자 기기가 여럿이어도 같은 대화를 본다).
 *
 * **알려진 오더의 당사자가 보낸 것만** 중계한다. `p=APP`인 dispute-message는 누구나 쏠 수 있다 —
 * 가리지 않으면 운영자 폰이 스팸 창구가 된다.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import {
  ADMIN_ACTIONS, MAX_CHAT_TEXT, REQUEST_ACTIONS, SAJWO_REQUEST_EVENT_KIND,
  extractOrderId, nip44Decrypt, nip44Encrypt, orderRef,
  type AdminChatCopy, type AdminCommandResult, type DisputeMessagePayload, type TrackName,
} from '@sajwo-tracker/shared/core';
import type { HandlerResult, InboxEvent } from '../dispatch';
import { tagValue } from '../dispatch';
import { isTrack, roleIn } from '../orders/directory';
import { PUBLISH_EFFECT, type PublishPayload } from '../nostr/publisher';
import { nowSec, type AdminContext } from './context';

/** 채팅 사본 보존 — 분쟁 기록이라 길게. 원본 dispute-message는 만료가 없다(증거) */
const CHAT_COPY_RETENTION_SEC = 90 * 24 * 60 * 60;

function isDisputePayload(v: unknown): v is DisputeMessagePayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (p.type === 'text') return typeof p.content === 'string';
  if (p.type === 'account-reveal') return typeof p.accountInfo === 'object' && p.accountInfo !== null;
  return false;
}

function trackOf(ctx: AdminContext, event: Pick<InboxEvent, 'tags'>): TrackName | null {
  const t = tagValue(event, 't');
  if (t === ctx.tags.ln) return 'ln';
  if (t === ctx.tags.onchain) return 'onchain';
  return null;
}

/** 유저 → APP dispute-message를 운영자에게 */
export function createChatForwarder(ctx: AdminContext): (event: InboxEvent) => HandlerResult {
  return event => {
    const track = trackOf(ctx, event);
    if (!track) return { outcome: 'ignored', reason: 'no-track' };
    const orderId = extractOrderId(event.tags);
    if (!orderId) return { outcome: 'ignored', reason: 'no-order' };

    const parties = ctx.directory.lookup(track, orderId);
    if (!parties) return { outcome: 'ignored', reason: 'unknown-order' };
    const role = roleIn(parties, event.pubkey);
    if (!role) return { outcome: 'ignored', reason: 'not-a-party' };

    let payload: unknown;
    try {
      payload = JSON.parse(nip44Decrypt(event.content, ctx.appKey.secretKey, event.pubkey));
    } catch {
      return { outcome: 'ignored', reason: 'undecryptable' };
    }
    if (!isDisputePayload(payload)) return { outcome: 'ignored', reason: 'bad-payload' };

    forwardToOperators(ctx, {
      track, orderId, from: event.pubkey, to: ctx.appKey.pubkey, role, payload,
      sentAt: event.created_at, originalId: event.id,
    });
    return { outcome: 'ok' };
  };
}

/**
 * 운영자 → 유저. `chat.send` 명령.
 *
 * 어드민은 텍스트만 보낸다 — 계좌 공개(`account-reveal`)는 유저만 하는 것이다.
 */
export function chatSend(ctx: AdminContext, args: Record<string, unknown>): AdminCommandResult {
  const fail = (error: string): AdminCommandResult => ({ ok: false, cmd: 'chat.send', error });
  const { track, orderId, to, text } = args;
  if (!isTrack(track) || typeof orderId !== 'string' || typeof to !== 'string') return fail('bad-args');
  if (typeof text !== 'string' || text.trim() === '') return fail('empty-text');
  if (text.length > MAX_CHAT_TEXT) return fail('too-long');

  const parties = ctx.directory.lookup(track, orderId);
  if (!parties) return fail('unknown-order');
  if (!roleIn(parties, to)) return fail('not-a-party');

  const payload: DisputeMessagePayload = { type: 'text', content: text };
  const createdAt = nowSec(ctx);
  // 증거라 만료를 달지 않는다 (CLAUDE.md 예외 — dispute-message)
  const event = finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: createdAt,
    tags: [
      ['a', orderRef(ctx.appKey.pubkey, orderId)],
      ['action', REQUEST_ACTIONS.DISPUTE_MESSAGE],
      ['t', track === 'ln' ? ctx.tags.ln : ctx.tags.onchain],
      ['p', to],
      ['p', ctx.appKey.pubkey],
    ],
    content: nip44Encrypt(JSON.stringify(payload), ctx.appKey.secretKey, to),
  }, ctx.appKey.secretKey);
  ctx.effects.enqueue<PublishPayload>(PUBLISH_EFFECT, { event }, { dedup: `chat:${event.id}` });

  forwardToOperators(ctx, {
    track, orderId, from: ctx.appKey.pubkey, to, role: 'admin', payload, sentAt: createdAt, originalId: event.id,
  });
  return { ok: true, cmd: 'chat.send', result: { eventId: event.id } };
}

function forwardToOperators(ctx: AdminContext, copy: AdminChatCopy): void {
  const createdAt = nowSec(ctx);
  for (const operator of ctx.operators) {
    const event = finalizeEvent({
      kind: SAJWO_REQUEST_EVENT_KIND,
      created_at: createdAt,
      tags: [
        ['p', operator],
        ['t', ctx.tags.admin],
        ['action', ADMIN_ACTIONS.CHAT],
        ['e', copy.originalId],
        ['expiration', String(createdAt + CHAT_COPY_RETENTION_SEC)],
      ],
      content: nip44Encrypt(JSON.stringify(copy), ctx.appKey.secretKey, operator),
    }, ctx.appKey.secretKey);
    ctx.effects.enqueue<PublishPayload>(PUBLISH_EFFECT, { event }, { dedup: `chat-copy:${copy.originalId}:${operator}` });
  }
}
