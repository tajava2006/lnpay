/**
 * P2 명령 채널 — 설정 · 경보 · 운영자 상태 · 분쟁 채팅 중계 · 버전 확인
 */
import { describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools/core';
import { finalizeEvent } from 'nostr-tools/pure';
import { unwrapEvent } from 'nostr-tools/nip17';
import {
  ADMIN_ACTIONS, ADMIN_STATE_KIND, DEFAULT_SETTINGS, PROTOCOL_VERSION, REQUEST_ACTIONS, MESSAGE_KIND,
  adminStateDTag, applySettingsPatch, nip44Decrypt, nip44Encrypt, orderRef,
  type AdminChatCopy, type AdminState, type DisputeMessagePayload,
} from '@sajwo-tracker/shared/core';
import { raiseAlert } from '../admin/alerts';
import { chatPushTag } from '../admin/chat';
import { PEER_PUSH_QUIET_SEC, peerPushTag } from '../admin/peer-chat';
import { NOTIFY } from '../ln/notify-messages';
import { PUSH_EFFECT, type PushMessage, type PushPayload } from '../push/send';
import { Db } from '../db';
import { resolveEpoch } from '../nostr/ingress';
import { STATE_INTERVAL_MS } from '../admin/state';
import { checkTarget } from '../orders/directory';
import {
  FakeDirectory, TEST_TAGS as TAGS, adminCommand, createHarness, eventsTo, newKey, openResult,
  type Harness, type TestKey,
} from './fakes';

/** 운영자가 명령을 보내고 한 바퀴 돌린 뒤 결과를 연다 */
async function command(h: Harness, daemon: import('../runtime').Daemon, payload: unknown, operator = h.operator) {
  const cmd = adminCommand(operator, h.app.pubkey, TAGS.admin, payload, h.sec());
  h.relay.inject(cmd);
  await h.settle(daemon);
  const result = eventsTo(h.relay, operator.pubkey, ADMIN_ACTIONS.RESULT).find(e => e.tags.some(t => t[0] === 'e' && t[1] === cmd.id));
  if (!result) throw new Error('결과가 안 왔다');
  return openResult(result, operator, h.app.pubkey) as { ok: boolean; result?: unknown; error?: string };
}

/** 이 운영자에게 간 가장 최근 상태 */
function latestState(h: Harness, operator: TestKey): { event: Event; state: AdminState } {
  const d = adminStateDTag(TAGS.admin, operator.pubkey);
  const events = h.relay.published
    .filter(e => e.kind === ADMIN_STATE_KIND && e.tags.some(t => t[0] === 'd' && t[1] === d))
    .sort((a, b) => a.created_at - b.created_at);
  const event = events.at(-1);
  if (!event) throw new Error('상태가 안 왔다');
  return { event, state: JSON.parse(nip44Decrypt(event.content, operator.secretKey, h.app.pubkey)) as AdminState };
}

describe('설정 (config.get / config.set)', () => {
  it('기본값을 돌려준다', async () => {
    const h = createHarness();
    const daemon = h.start();
    expect((await command(h, daemon, { cmd: 'config.get' })).result).toEqual(DEFAULT_SETTINGS);
  });

  it('바꾸면 저장되고 운영자 상태에 실린다', async () => {
    const h = createHarness();
    const daemon = h.start();
    const r = await command(h, daemon, { cmd: 'config.set', args: { patch: { ln: { sponsorDepositPct: 3 } } } });
    expect(r.ok).toBe(true);
    expect((await command(h, daemon, { cmd: 'config.get' })).result).toMatchObject({ ln: { sponsorDepositPct: 3 } });
    expect(latestState(h, h.operator).state.settings.ln.sponsorDepositPct).toBe(3);
  });

  /** 반만 적용된 설정이 제일 위험하다 — 하나라도 틀리면 통째로 거부 */
  it('틀린 키·값이 섞이면 통째로 거부하고 아무것도 안 바꾼다', async () => {
    const h = createHarness();
    const daemon = h.start();
    const r = await command(h, daemon, {
      cmd: 'config.set', args: { patch: { ln: { autoApprove: false, sponsorDepositPct: 99 } } },
    });
    expect(r).toMatchObject({ ok: false });
    expect((await command(h, daemon, { cmd: 'config.get' })).result).toEqual(DEFAULT_SETTINGS);
  });

  it('검증 규칙', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { ln: { customerDepositPct: 2.345 } }))
      .toMatchObject({ ok: true, settings: { ln: { customerDepositPct: 2.35 } } });
    expect(applySettingsPatch(DEFAULT_SETTINGS, { ln: { customerDepositPct: -1 } }).ok).toBe(false);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { onchain: { acceptNewOrders: 'yes' } }).ok).toBe(false);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { lightning: {} }).ok).toBe(false);
    expect(applySettingsPatch(DEFAULT_SETTINGS, [1]).ok).toBe(false);
  });
});

describe('운영자 상태', () => {
  it('운영자마다 따로, 그 운영자만 열 수 있다', async () => {
    const h = createHarness({ operators: 2 });
    const daemon = h.start();
    await daemon.tick();
    const [a, b] = h.operators as [TestKey, TestKey];
    expect(latestState(h, a).state.mode).toBe('dev');
    expect(latestState(h, b).state.mode).toBe('dev');
    expect(() => nip44Decrypt(latestState(h, a).event.content, b.secretKey, h.app.pubkey)).toThrow();
  });

  it('하트비트로 주기적으로 다시 낸다 — created_at은 계속 올라간다', async () => {
    const h = createHarness();
    const daemon = h.start();
    await daemon.tick();
    const first = latestState(h, h.operator);
    h.clock.now += STATE_INTERVAL_MS;
    await daemon.tick();
    const second = latestState(h, h.operator);
    expect(second.event.created_at).toBeGreaterThan(first.event.created_at);
    expect(second.state.heartbeatAt).toBeGreaterThan(first.state.heartbeatAt);
  });

  it('프로토콜 버전을 싣는다 — 어드민이 한쪽만 배포한 걸 알아본다', async () => {
    const h = createHarness();
    const daemon = h.start();
    await daemon.tick();
    expect(latestState(h, h.operator).state.protocol).toBe(PROTOCOL_VERSION);
  });

  it('받기 시작한 시각(epoch)을 싣는다 — 어드민이 그 전의 오더를 거르는 기준', async () => {
    const h = createHarness();
    const epoch = h.sec() - 3600; // 하네스가 넘기는 값
    const daemon = h.start();
    await daemon.tick();
    expect(latestState(h, h.operator).state.epoch).toBe(epoch);
  });

  it('epoch는 첫 부팅 값에 고정된다 — 설정을 바꿔도 움직이지 않는다', () => {
    const db = new Db(':memory:');
    expect(resolveEpoch(db, 1_000)).toBe(1_000);
    expect(resolveEpoch(db, 2_000)).toBe(1_000);
  });

  /** addressable은 created_at이 같으면 id가 작은 쪽이 남는다 — 같은 초 두 발행에서 옛 상태가 남으면 안 된다 */
  it('같은 초에 두 번 내도 뒤의 것이 더 늦은 created_at', async () => {
    const h = createHarness();
    const daemon = h.start();
    await daemon.tick();
    const first = latestState(h, h.operator).event.created_at;
    await command(h, daemon, { cmd: 'config.set', args: { patch: { ln: { autoApprove: false } } } });
    h.clock.now -= 2_000; // 시계가 같은 초에 머문 것처럼
    await command(h, daemon, { cmd: 'config.set', args: { patch: { ln: { autoApprove: true } } } });
    const created = h.relay.published.filter(e => e.kind === ADMIN_STATE_KIND).map(e => e.created_at);
    expect(new Set(created).size).toBe(created.length);
    expect(Math.min(...created)).toBe(first);
  });
});

describe('경보', () => {
  it('새 경보는 상태에 실리고 운영자에게 DM이 간다 — 같은 사유는 한 번만', async () => {
    const h = createHarness();
    const daemon = h.start();
    daemon.admin.db.tx(() => {
      expect(raiseAlert(daemon.admin, { dedup: 'ln:o-1:x', level: 'anomaly', track: 'ln', orderId: 'o-1', message: '정산 실패' })).toBe(true);
      expect(raiseAlert(daemon.admin, { dedup: 'ln:o-1:x', level: 'anomaly', message: '정산 실패' })).toBe(false);
    });
    await daemon.tick();

    const { state } = latestState(h, h.operator);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0]).toMatchObject({ level: 'anomaly', track: 'ln', orderId: 'o-1', message: '정산 실패' });

    const dms = h.relay.published.filter(e => e.kind === 1059);
    expect(dms).toHaveLength(1);
    expect(unwrapEvent(dms[0]!, h.operator.secretKey).content).toContain('정산 실패');
  });

  it('확인하면 상태에서 빠진다', async () => {
    const h = createHarness();
    const daemon = h.start();
    daemon.admin.db.tx(() => raiseAlert(daemon.admin, { dedup: 'a', level: 'warn', message: 'm' }));
    await daemon.tick();
    const id = latestState(h, h.operator).state.alerts[0]!.id;
    expect((await command(h, daemon, { cmd: 'alert.ack', args: { id } })).ok).toBe(true);
    expect(latestState(h, h.operator).state.alerts).toHaveLength(0);
    expect((await command(h, daemon, { cmd: 'alert.ack', args: { id } })).ok).toBe(false);
  });
});

// ── 분쟁 채팅 중계 ──────────────────────────────────────────

function disputeMessage(from: TestKey, appPubkey: string, orderId: string, text: string, createdAt: number, t = TAGS.ln): Event {
  return finalizeEvent({
    kind: MESSAGE_KIND,
    created_at: createdAt,
    tags: [
      ['a', orderRef(appPubkey, orderId)],
      ['action', REQUEST_ACTIONS.DISPUTE_MESSAGE],
      ['t', t],
      ['p', appPubkey],
      ['p', from.pubkey],
    ],
    content: nip44Encrypt(JSON.stringify({ type: 'text', content: text }), from.secretKey, appPubkey),
  }, from.secretKey);
}

/** 이 사람에게 쌓인 웹 푸시 — 보내기 전 평문이 효과 대기열에 있다 */
function pushesTo(daemon: import('../runtime').Daemon, pubkey: string): PushMessage[] {
  return daemon.admin.db.all<{ payload: string }>('SELECT payload FROM effects WHERE kind = ? ORDER BY id', PUSH_EFFECT)
    .map(r => JSON.parse(r.payload) as PushPayload)
    .filter(p => p.pubkey === pubkey)
    .map(p => p.message);
}

function chatCopies(h: Harness, operator: TestKey): AdminChatCopy[] {
  return eventsTo(h.relay, operator.pubkey, ADMIN_ACTIONS.CHAT)
    .map(e => JSON.parse(nip44Decrypt(e.content, operator.secretKey, h.app.pubkey)) as AdminChatCopy);
}

describe('분쟁 채팅 중계', () => {
  function withOrder() {
    const h = createHarness({ operators: 2 });
    const customer = newKey();
    const sponsor = newKey();
    h.directory.set('ln', 'o-1', { version: 3, customer: customer.pubkey, sponsor: sponsor.pubkey });
    return { h, customer, sponsor };
  }

  it('당사자가 보낸 메시지를 운영자 전원에게 풀어서 다시 보낸다', async () => {
    const { h, customer } = withOrder();
    const daemon = h.start();
    const msg = disputeMessage(customer, h.app.pubkey, 'o-1', '입금 안 됐어요', h.sec());
    h.relay.inject(msg);
    await h.settle(daemon);
    for (const op of h.operators) {
      expect(chatCopies(h, op)).toEqual([{
        track: 'ln', orderId: 'o-1', from: customer.pubkey, to: h.app.pubkey, role: 'customer',
        payload: { type: 'text', content: '입금 안 됐어요' }, sentAt: msg.created_at, originalId: msg.id,
      }]);
    }
  });

  /** p=APP인 dispute-message는 누구나 쏠 수 있다 — 가리지 않으면 운영자 폰이 스팸 창구가 된다 */
  it('당사자가 아니거나 모르는 오더면 중계하지 않는다', async () => {
    const { h } = withOrder();
    const daemon = h.start();
    h.relay.inject(disputeMessage(newKey(), h.app.pubkey, 'o-1', 'spam', h.sec()));
    h.relay.inject(disputeMessage(newKey(), h.app.pubkey, 'o-unknown', 'spam', h.sec()));
    await h.settle(daemon);
    expect(chatCopies(h, h.operator)).toHaveLength(0);
  });

  it('트랙 태그가 맞아야 한다 — 온체인 오더를 라이트닝 태그로 보내면 모르는 오더다', async () => {
    const { h, customer } = withOrder();
    const daemon = h.start();
    h.relay.inject(disputeMessage(customer, h.app.pubkey, 'o-1', 'x', h.sec(), TAGS.onchain));
    await h.settle(daemon);
    expect(chatCopies(h, h.operator)).toHaveLength(0);
  });

  it('chat.send — APP으로 당사자에게 보내고, 운영자 전원에게 사본', async () => {
    const { h, sponsor } = withOrder();
    const daemon = h.start();
    const r = await command(h, daemon, { cmd: 'chat.send', args: { track: 'ln', orderId: 'o-1', to: sponsor.pubkey, text: '송금 증빙을 올려주세요' } });
    expect(r.ok).toBe(true);
    const eventId = (r.result as { eventId: string }).eventId;

    const sent = h.relay.published.find(e => e.id === eventId)!;
    expect(sent.pubkey).toBe(h.app.pubkey);
    expect(sent.tags).toContainEqual(['p', sponsor.pubkey]);
    expect(sent.tags.some(t => t[0] === 'expiration')).toBe(false); // 증거 — 만료 없음
    expect(JSON.parse(nip44Decrypt(sent.content, sponsor.secretKey, h.app.pubkey))).toEqual({
      type: 'text', content: '송금 증빙을 올려주세요',
    });
    for (const op of h.operators) {
      expect(chatCopies(h, op)).toMatchObject([{ from: h.app.pubkey, to: sponsor.pubkey, role: 'admin', originalId: eventId }]);
    }
  });

  /** 유저 앱은 거래 화면을 열어 둔 동안만 채팅을 받는다 — 알림이 없으면 운영자 질문을 모른다(2026-10-20 고객 피드백) */
  it('chat.send — 받는 사람에게만 웹 푸시, 내용은 싣지 않고 그 거래 화면으로', async () => {
    const { h, customer, sponsor } = withOrder();
    const daemon = h.start();
    await command(h, daemon, { cmd: 'chat.send', args: { track: 'ln', orderId: 'o-1', to: sponsor.pubkey, text: '송금 증빙을 올려주세요' } });
    await command(h, daemon, { cmd: 'chat.send', args: { track: 'ln', orderId: 'o-1', to: customer.pubkey, text: '입금 내역 보여주세요' } });

    const toSponsor = pushesTo(daemon, sponsor.pubkey);
    expect(toSponsor).toEqual([{
      title: '페어바이', body: NOTIFY.operatorMessage('fulfill', 'ln').body, url: '/?order=o-1', tag: chatPushTag('o-1'),
    }]);
    expect(toSponsor[0]!.body).not.toContain('송금 증빙'); // 잠금화면에 뜰 수 있다
    expect(pushesTo(daemon, customer.pubkey)).toMatchObject([{ url: '/?tab=request&order=o-1', tag: chatPushTag('o-1') }]);
    // 거래 알림(tag = 오더 id)을 덮어 지우지 않는다
    expect(chatPushTag('o-1')).not.toBe('o-1');
  });

  it('chat.send — 온체인이면 온체인 화면으로', async () => {
    const h = createHarness();
    const customer = newKey();
    h.directory.set('onchain', 'oc-1', { version: 1, customer: customer.pubkey });
    const daemon = h.start();
    await command(h, daemon, { cmd: 'chat.send', args: { track: 'onchain', orderId: 'oc-1', to: customer.pubkey, text: 'hi' } });
    expect(pushesTo(daemon, customer.pubkey)).toMatchObject([{ url: '/?track=onchain&tab=request&order=oc-1' }]);
  });

  /** 유저 → 운영자 방향은 운영자 DM이 맡는다 — 보낸 유저 자신의 폰을 울리지 않는다 */
  it('유저가 보낸 메시지로는 웹 푸시가 안 나간다', async () => {
    const { h, customer } = withOrder();
    const daemon = h.start();
    h.relay.inject(disputeMessage(customer, h.app.pubkey, 'o-1', '입금 안 됐어요', h.sec()));
    await h.settle(daemon);
    expect(daemon.admin.db.all('SELECT 1 FROM effects WHERE kind = ?', PUSH_EFFECT)).toHaveLength(0);
  });

  it('chat.send 거절 — 모르는 오더 · 당사자 아님 · 빈 글 · 너무 김', async () => {
    const { h, customer } = withOrder();
    const daemon = h.start();
    const send = (args: Record<string, unknown>) => command(h, daemon, { cmd: 'chat.send', args });
    expect(await send({ track: 'ln', orderId: 'nope', to: customer.pubkey, text: 'x' })).toMatchObject({ error: 'unknown-order' });
    expect(await send({ track: 'ln', orderId: 'o-1', to: newKey().pubkey, text: 'x' })).toMatchObject({ error: 'not-a-party' });
    expect(await send({ track: 'ln', orderId: 'o-1', to: customer.pubkey, text: '  ' })).toMatchObject({ error: 'empty-text' });
    expect(await send({ track: 'ln', orderId: 'o-1', to: customer.pubkey, text: 'x'.repeat(2001) })).toMatchObject({ error: 'too-long' });
  });

  /** 어드민이 보낸 메시지도 p=APP이라 수신함으로 되돌아온다 — 다시 중계하면 사본이 두 벌 */
  it('우리가 낸 이벤트는 처리하지 않는다', async () => {
    const { h, customer } = withOrder();
    const daemon = h.start();
    await command(h, daemon, { cmd: 'chat.send', args: { track: 'ln', orderId: 'o-1', to: customer.pubkey, text: 'hi' } });
    await h.settle(daemon);
    expect(chatCopies(h, h.operator)).toHaveLength(1);
  });
});

// ── 상대방 채팅 · 운영자 부르기 (docs/PLAN-PEER-CHAT.md §6) ──────────────────

function disputePayload(
  from: TestKey, appPubkey: string, orderId: string, payload: DisputeMessagePayload, createdAt: number, t = TAGS.ln,
): Event {
  return finalizeEvent({
    kind: MESSAGE_KIND,
    created_at: createdAt,
    tags: [['a', orderRef(appPubkey, orderId)], ['action', REQUEST_ACTIONS.DISPUTE_MESSAGE], ['t', t], ['p', appPubkey], ['p', from.pubkey]],
    content: nip44Encrypt(JSON.stringify(payload), from.secretKey, appPubkey),
  }, from.secretKey);
}

/** 상대방 채팅 한 통 — 데몬은 내용을 못 연다(거래별 대화 키). 그래서 내용은 아무 문자열이어도 된다 */
function peerMessage(from: TestKey, to: string, appPubkey: string, orderId: string, createdAt: number, t = TAGS.ln): Event {
  return finalizeEvent({
    kind: MESSAGE_KIND,
    created_at: createdAt,
    tags: [
      ['a', orderRef(appPubkey, orderId)], ['action', REQUEST_ACTIONS.PEER_MESSAGE], ['t', t],
      ['p', to], ['p', from.pubkey], ['p', appPubkey], ['expiration', String(createdAt + 86_400)],
    ],
    content: 'ciphertext-under-the-order-key',
  }, from.secretKey);
}

const operatorDms = (h: Harness, op: TestKey): string[] => h.relay.published
  .filter(e => e.kind === 1059 && e.tags.some(t => t[0] === 'p' && t[1] === op.pubkey))
  .map(e => unwrapEvent(e, op.secretKey).content);

describe('상대방 채팅 → 푸시', () => {
  function withOrder(sponsored = true) {
    const h = createHarness({ operators: 2 });
    const customer = newKey();
    const sponsor = newKey();
    h.directory.set('ln', 'o-1', { version: 3, customer: customer.pubkey, ...(sponsored ? { sponsor: sponsor.pubkey } : {}) });
    return { h, customer, sponsor };
  }

  it('반대쪽에게만 내용 없이 — 받는 사람 탭으로, 상대방 채팅 태그로. 운영자에게는 아무것도 안 간다', async () => {
    const { h, customer, sponsor } = withOrder();
    const daemon = h.start();
    h.relay.inject(peerMessage(customer, sponsor.pubkey, h.app.pubkey, 'o-1', h.sec()));
    await h.settle(daemon);

    expect(pushesTo(daemon, sponsor.pubkey)).toEqual([{
      title: '페어바이', body: NOTIFY.peerMessage('fulfill', 'ln').body, url: '/?order=o-1', tag: peerPushTag('o-1'),
    }]);
    expect(pushesTo(daemon, customer.pubkey)).toHaveLength(0);
    // 거래 알림 · 운영자 채팅 알림을 덮어 지우지 않는다
    expect(peerPushTag('o-1')).not.toBe('o-1');
    expect(peerPushTag('o-1')).not.toBe(chatPushTag('o-1'));
    expect(chatCopies(h, h.operator)).toHaveLength(0);
    expect(operatorDms(h, h.operator)).toHaveLength(0);
  });

  it('사는 사람이 보내면 파는 사람의 팔기 탭으로 · 온체인이면 온체인 화면으로', async () => {
    const h = createHarness();
    const customer = newKey();
    const sponsor = newKey();
    h.directory.set('onchain', 'oc-1', { version: 1, customer: customer.pubkey, sponsor: sponsor.pubkey });
    const daemon = h.start();
    h.relay.inject(peerMessage(sponsor, customer.pubkey, h.app.pubkey, 'oc-1', h.sec(), TAGS.onchain));
    await h.settle(daemon);
    expect(pushesTo(daemon, customer.pubkey)).toMatchObject([{ url: '/?track=onchain&tab=request&order=oc-1' }]);
  });

  /** RoboSats와 같은 규칙 — 첫 메시지는 늘, 말이 오가는 중엔 조용히, 한참 조용했다가 온 말은 다시 */
  it('조용한 창', async () => {
    const { h, customer, sponsor } = withOrder();
    const daemon = h.start();
    const say = async (from: TestKey, to: TestKey) => {
      h.relay.inject(peerMessage(from, to.pubkey, h.app.pubkey, 'o-1', h.sec()));
      await h.settle(daemon);
    };
    await say(customer, sponsor);
    h.clock.now += 60_000;
    await say(sponsor, customer); // 1분 뒤 답장 — 대화 중
    h.clock.now += 60_000;
    await say(customer, sponsor);
    expect(pushesTo(daemon, sponsor.pubkey)).toHaveLength(1);
    expect(pushesTo(daemon, customer.pubkey)).toHaveLength(0);

    h.clock.now += (PEER_PUSH_QUIET_SEC + 60) * 1000;
    await say(sponsor, customer); // 한참 조용했다
    expect(pushesTo(daemon, customer.pubkey)).toHaveLength(1);
  });

  /** p=APP은 누구나 달 수 있다 — 가리지 않으면 아무 유저의 폰이나 울리는 창구가 된다 */
  it('당사자가 아니거나 · 모르는 오더거나 · 상대가 아직 없으면 안 울린다', async () => {
    const { h, customer, sponsor } = withOrder(false);
    const daemon = h.start();
    h.relay.inject(peerMessage(newKey(), customer.pubkey, h.app.pubkey, 'o-1', h.sec()));
    h.relay.inject(peerMessage(customer, sponsor.pubkey, h.app.pubkey, 'o-unknown', h.sec()));
    h.relay.inject(peerMessage(customer, sponsor.pubkey, h.app.pubkey, 'o-1', h.sec()));
    await h.settle(daemon);
    expect(daemon.admin.db.all('SELECT 1 FROM effects WHERE kind = ?', PUSH_EFFECT)).toHaveLength(0);
  });
});

describe('운영자 부르기', () => {
  const KEY = 'ab'.repeat(32);
  function withOrder() {
    const h = createHarness({ operators: 2 });
    const customer = newKey();
    const sponsor = newKey();
    h.directory.set('ln', 'o-1', { version: 3, customer: customer.pubkey, sponsor: sponsor.pubkey });
    return { h, customer, sponsor };
  }
  const call = (reason: string, peerChatKey?: string): DisputeMessagePayload =>
    ({ type: 'call', reason, ...(peerChatKey ? { peerChatKey } : {}) });

  it('사본에 대화 키가 실려 운영자 전원에게 간다 — 어드민이 두 사람 대화를 연다', async () => {
    const { h, customer } = withOrder();
    const daemon = h.start();
    h.relay.inject(disputePayload(customer, h.app.pubkey, 'o-1', call('입금이 안 들어와요', KEY), h.sec()));
    await h.settle(daemon);
    for (const op of h.operators) {
      expect(chatCopies(h, op)).toContainEqual(expect.objectContaining({
        from: customer.pubkey, role: 'customer', payload: { type: 'call', reason: '입금이 안 들어와요', peerChatKey: KEY },
      }));
    }
  });

  /** 운영자 채팅은 거래당 10분에 한 번 울린다 — 부르기는 그 창에 걸리면 안 된다 */
  it('운영자 DM은 조용한 창 없이 바로 — 방금 채팅을 보냈어도', async () => {
    const { h, customer } = withOrder();
    const daemon = h.start();
    h.relay.inject(disputeMessage(customer, h.app.pubkey, 'o-1', '여보세요', h.sec()));
    await h.settle(daemon);
    h.relay.inject(disputePayload(customer, h.app.pubkey, 'o-1', call('입금이 안 들어와요', KEY), h.sec()));
    await h.settle(daemon);
    const dms = operatorDms(h, h.operator);
    expect(dms).toHaveLength(2);
    expect(dms[1]).toContain('운영자 호출');
    expect(dms[1]).toContain('입금이 안 들어와요');
    expect(dms[1]).toContain('대화 공개');
  });

  const signalsTo = (h: ReturnType<typeof createHarness>, to: { pubkey: string; secretKey: Uint8Array }) =>
    eventsTo(h.relay, to.pubkey, REQUEST_ACTIONS.DISPUTE_MESSAGE)
      .filter(e => e.pubkey === h.app.pubkey)
      .map(e => JSON.parse(nip44Decrypt(e.content, to.secretKey, h.app.pubkey)) as unknown);

  /** 대화 키는 두 사람이 같다 — 두 번째 공개는 바뀌는 게 없으니 처음 부른 사람에게 되돌아가지 않는다(앱은 버튼을 잠근다) */
  it('상대방에게 called 신호 + 푸시 — 오더마다 한 번', async () => {
    const { h, customer, sponsor } = withOrder();
    const daemon = h.start();
    h.relay.inject(disputePayload(customer, h.app.pubkey, 'o-1', call('첫 번째', KEY), h.sec()));
    await h.settle(daemon);
    h.relay.inject(disputePayload(customer, h.app.pubkey, 'o-1', call('두 번째', KEY), h.sec()));
    h.relay.inject(disputePayload(sponsor, h.app.pubkey, 'o-1', call('나도 부름', KEY), h.sec()));
    await h.settle(daemon);

    // 말풍선(text)이 아니라 신호다 — 상대 앱이 상대방 칸 안내를 바꾸고 부르기를 잠근다
    expect(signalsTo(h, sponsor)).toEqual([{ type: 'called' }]);
    expect(signalsTo(h, customer)).toEqual([]);
    expect(pushesTo(daemon, sponsor.pubkey)).toEqual([{
      title: '페어바이', body: NOTIFY.operatorCalled('fulfill', 'ln').body, url: '/?order=o-1', tag: chatPushTag('o-1'),
    }]);
    expect(pushesTo(daemon, customer.pubkey)).toHaveLength(0);
    // 운영자는 매번 — 부르기는 드물고 놓치면 안 된다
    expect(operatorDms(h, h.operator).filter(d => d.includes('운영자 호출'))).toHaveLength(3);
  });

  /** 상대방 칸이 아직 없을 때(예: 후원자 보증금 대기) 부르면 키가 없다 — 공개된 게 없으니 상대에게 알릴 것도 없다 */
  it('키 없이 부르면 상대에게 알리지 않는다 — 나중에 키를 넘길 때 알린다', async () => {
    const { h, customer, sponsor } = withOrder();
    const daemon = h.start();
    h.relay.inject(disputePayload(customer, h.app.pubkey, 'o-1', call('보증금이 안 잡혀요'), h.sec()));
    await h.settle(daemon);
    expect(signalsTo(h, sponsor)).toEqual([]);
    expect(pushesTo(daemon, sponsor.pubkey)).toHaveLength(0);

    h.relay.inject(disputePayload(customer, h.app.pubkey, 'o-1', call('대화도 봐 주세요', KEY), h.sec()));
    await h.settle(daemon);
    expect(signalsTo(h, sponsor)).toEqual([{ type: 'called' }]);
  });

  it('상대가 아직 없으면 키 없이 부르고, 알릴 상대도 없다', async () => {
    const h = createHarness();
    const customer = newKey();
    h.directory.set('ln', 'o-2', { version: 1, customer: customer.pubkey });
    const daemon = h.start();
    h.relay.inject(disputePayload(customer, h.app.pubkey, 'o-2', call('판매가 안 올라가요'), h.sec()));
    await h.settle(daemon);
    expect(chatCopies(h, h.operator)).toHaveLength(1);
    expect(operatorDms(h, h.operator)[0]).not.toContain('대화 공개');
    expect(daemon.admin.db.all('SELECT 1 FROM effects WHERE kind = ?', PUSH_EFFECT)).toHaveLength(0);
  });

  it('모양이 틀리면 버린다 — 빈 사유 · 엉뚱한 키', async () => {
    const { h, customer } = withOrder();
    const daemon = h.start();
    h.relay.inject(disputePayload(customer, h.app.pubkey, 'o-1', call('  ', KEY), h.sec()));
    h.relay.inject(disputePayload(customer, h.app.pubkey, 'o-1', call('x', 'not-a-key'), h.sec()));
    await h.settle(daemon);
    expect(chatCopies(h, h.operator)).toHaveLength(0);
  });
});

describe('버전 확인 (DM-006)', () => {
  const dir = new FakeDirectory();
  dir.set('onchain', 'o-9', { version: 5, customer: 'c' });

  it('버전이 같아야 통과', () => {
    expect(checkTarget(dir, { track: 'onchain', orderId: 'o-9', version: 5 })).toMatchObject({ ok: true });
  });

  /** 낡은 화면에서 누른 판정 — 이미 다른 기기에서 끝낸 일을 또 하거나, 달라진 상황을 모른 채 결정한다 */
  it('낡은 버전은 거절', () => {
    expect(checkTarget(dir, { track: 'onchain', orderId: 'o-9', version: 4 })).toEqual({ ok: false, error: 'stale-version' });
  });

  it('모르는 오더 · 모양이 틀린 대상', () => {
    expect(checkTarget(dir, { track: 'ln', orderId: 'o-9', version: 5 })).toEqual({ ok: false, error: 'unknown-order' });
    expect(checkTarget(dir, { track: 'btc', orderId: 'o-9', version: 5 })).toEqual({ ok: false, error: 'bad-target' });
    expect(checkTarget(dir, { track: 'onchain', orderId: 'o-9', version: '5' })).toEqual({ ok: false, error: 'bad-target' });
    expect(checkTarget(dir, null)).toEqual({ ok: false, error: 'bad-target' });
  });
});
