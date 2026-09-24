/**
 * 분쟁 채팅 가르기 — 고객·후원자 대화가 섞이지 않는다 (2026-09-24 드릴)
 */
import { describe, expect, it } from 'vitest';
import type { AdminChatCopy } from '@sajwo-tracker/shared';
import { splitThreads } from './DisputeChat';

const APP = 'a'.repeat(64);
const C = 'c'.repeat(64);
const S = 's'.repeat(64);
const OLD = 'o'.repeat(64);

let seq = 0;
function msg(from: string, to: string, role: AdminChatCopy['role']): AdminChatCopy {
  return {
    track: 'ln', orderId: 'x', from, to, role, sentAt: seq, originalId: String(seq++),
    payload: { type: 'text', content: 'hi' },
  };
}

describe('splitThreads', () => {
  it('유저가 보낸 건 보낸 사람, 운영자가 보낸 건 받는 사람으로 간다', () => {
    const all = [msg(C, APP, 'customer'), msg(APP, C, 'admin'), msg(S, APP, 'sponsor'), msg(APP, S, 'admin')];
    const t = splitThreads(all, C, S);
    expect(t.customer.map(m => m.originalId)).toEqual([all[0]!.originalId, all[1]!.originalId]);
    expect(t.sponsor.map(m => m.originalId)).toEqual([all[2]!.originalId, all[3]!.originalId]);
    expect(t.others).toEqual([]);
  });

  it('풀린 클레임의 옛 후원자와의 대화는 따로 남긴다 — 버리지도, 지금 후원자에 섞지도 않는다', () => {
    const old = msg(OLD, APP, 'sponsor');
    const t = splitThreads([old, msg(S, APP, 'sponsor')], C, S);
    expect(t.others).toEqual([old]);
    expect(t.sponsor).toHaveLength(1);
  });

  it('후원자가 아직 없으면 후원자 대화는 비어 있다', () => {
    const t = splitThreads([msg(C, APP, 'customer')], C, undefined);
    expect(t.sponsor).toEqual([]);
    expect(t.customer).toHaveLength(1);
  });
});
