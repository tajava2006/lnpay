/**
 * 거래 상세 대화 — 실제 렌더 (docs/PLAN-PEER-CHAT.md §8)
 *
 * 2026-10-24 피드백: 운영자와의 1:1을 상대방과의 대화로 알았다. 여기서 지키는 것 — 상대방 칸과 운영자 칸이 **이름으로
 * 갈리고**, 운영자 칸은 **부르기 전엔 없고**, 부르기는 대화 공개를 말한 뒤에만 나가며, 대화 키는 화면에 안 그린다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage, PreparedChatMessage } from '@sajwo-tracker/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'm'.repeat(64);
const PEER = 'p'.repeat(64);
const KEY = 'ab'.repeat(32);

// 릴레이는 열지 않는다 — 화면은 채팅 스토어만 본다(헌법 2)
vi.mock('@sajwo-tracker/shared', async importOriginal => ({
  ...(await importOriginal<object>()),
  subscribeChatMessages: vi.fn(async () => () => {}),
  subscribePeerMessages: vi.fn(async () => () => {}),
  loadFromIdb: vi.fn(async () => {}),
}));

const calls: string[] = [];
vi.mock('../nostr/peer-message', () => ({
  preparePeerMessage: vi.fn(),
  prepareOperatorCall: vi.fn(async (args: { orderId: string; peerPubkey: string | null }, reason: string): Promise<PreparedChatMessage> => {
    calls.push(reason);
    return {
      message: {
        eventId: `call-${calls.length}`, orderId: args.orderId, senderPubkey: ME, recipientPubkey: 'app', createdAt: 1,
        payload: { type: 'call', reason, ...(args.peerPubkey ? { peerChatKey: KEY } : {}) },
      },
      publish: async () => true,
    };
  }),
}));

const shared = await import('@sajwo-tracker/shared');
const { TradeChat } = await import('../chat/TradeChat');

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text));
const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  eventId: 'e1', orderId: 'o1', senderPubkey: PEER, recipientPubkey: ME, createdAt: 1, payload: { type: 'text', content: '안녕하세요' },
  ...over,
});

describe('거래 상세 대화', () => {
  it('상대가 있으면 상대방 칸 — 운영자는 안 본다고 말하고, 운영자 칸은 부르기 전엔 없다', () => {
    act(() => root.render(<TradeChat track="ln" orderId="o1" myPubkey={ME} role="customer" peer={{ pubkey: PEER, readOnly: false }} />));
    expect(host.textContent).toContain('상대방(사는 사람)과 대화 — 운영자는 보지 않습니다');
    expect(host.textContent).toContain('채팅으로 보낸 계좌는 분쟁에서 인정되지 않습니다');
    expect(host.textContent).not.toContain('운영자와 대화');
    expect(button('운영자 부르기')).toBeDefined();
  });

  it('상대가 아직 없으면 상대방 칸도 없다 — 부르기만', () => {
    act(() => root.render(<TradeChat track="onchain" orderId="o1" myPubkey={ME} role="customer" peer={null} />));
    expect(host.textContent).not.toContain('상대방(');
    expect(button('운영자 부르기')).toBeDefined();
  });

  it('상대방 메시지는 상대방 칸에, 운영자 메시지가 오면 운영자 칸이 열린다', () => {
    act(() => root.render(<TradeChat track="ln" orderId="o1" myPubkey={ME} role="sponsor" peer={{ pubkey: PEER, readOnly: false }} />));
    act(() => shared.addMessage(msg({ eventId: 'peer-1', channel: 'peer', payload: { type: 'text', content: '계좌 보냈어요' } })));
    expect(host.textContent).toContain('계좌 보냈어요');
    expect(host.textContent).not.toContain('운영자와 대화');

    act(() => shared.addMessage(msg({ eventId: 'op-1', senderPubkey: 'app', payload: { type: 'text', content: '송금 증빙 있나요?' } })));
    expect(host.textContent).toContain('운영자와 대화 — 상대방은 보지 않습니다');
    // 운영자가 먼저 말을 걸었어도 대화는 아직 공개 전이다 — 공개하는 길을 남긴다
    expect(button('운영자에게 상대방과의 대화 보여주기')).toBeDefined();
  });

  it('부르기는 대화 공개를 말하고 사유가 있어야 나간다 — 나간 뒤 키는 화면에 없다', async () => {
    act(() => root.render(<TradeChat track="ln" orderId="o2" myPubkey={ME} role="customer" peer={{ pubkey: PEER, readOnly: false }} />));
    act(() => button('운영자 부르기')!.click());
    expect(document.body.textContent).toContain('상대방과 나눈 대화를 운영자가 읽을 수 있게 됩니다');

    const submit = () => {
      const found = [...document.querySelectorAll('button')].filter(b => b.textContent === '운영자 부르기');
      return found[found.length - 1]!; // 확인창 안의 버튼 — 열린 버튼과 이름이 같다
    };
    expect(submit().disabled).toBe(true);
    const textarea = document.querySelector('textarea[placeholder^="예: 송금"]') as HTMLTextAreaElement;
    act(() => {
      Reflect.set(HTMLTextAreaElement.prototype, 'value', '입금이 안 들어왔어요', textarea);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { submit().click(); });

    expect(calls).toEqual(['입금이 안 들어왔어요']);
    expect(host.textContent).toContain('운영자 호출 · 상대방과의 대화 공개');
    expect(host.textContent).not.toContain(KEY);
    expect(button('운영자에게 상대방과의 대화 보여주기')).toBeUndefined(); // 이미 공개했다
    // 상대방 칸이 더는 "운영자는 보지 않습니다"라고 하지 않는다
    expect(host.textContent).toContain('상대방(사는 사람)과 대화 — 운영자도 봅니다');
    expect(host.textContent).toContain('운영자를 불렀습니다 — 이제 운영자가 이 대화를 처음부터 전부 볼 수');
    expect(host.textContent).not.toContain('운영자는 보지 않습니다');
  });

  /** 2026-10-24 메인넷 확인: 상대가 부른 뒤에도 내 쪽에 부르기가 남아 있었고, 누르면 처음 부른 사람에게 또 알림이 갔다 */
  it('상대가 부르면 — 안내가 바뀌고 부르기가 잠긴다 · 신호는 말풍선이 아니다', () => {
    act(() => root.render(<TradeChat track="ln" orderId="o4" myPubkey={ME} role="sponsor" peer={{ pubkey: PEER, readOnly: false }} />));
    act(() => shared.addMessage(msg({
      eventId: 'sig-1', orderId: 'o4', senderPubkey: shared.APP_PUBKEY, payload: { type: 'called' },
    })));
    expect(host.textContent).toContain('상대방(파는 사람)과 대화 — 운영자도 봅니다');
    expect(host.textContent).toContain('상대방이 운영자를 불렀습니다 — 이제 운영자가 이 대화를 처음부터 전부 볼 수');
    expect(host.textContent).not.toContain('운영자와 대화'); // 운영자 칸을 열지 않는다
    expect(host.textContent).not.toContain('호출 알림');
    expect(button('운영자 부르기')?.disabled).toBe(true);
    expect(button('운영자에게 상대방과의 대화 보여주기')).toBeUndefined();
  });

  it('APP이 아닌 사람이 보낸 called는 무시한다', () => {
    act(() => root.render(<TradeChat track="ln" orderId="o5" myPubkey={ME} role="sponsor" peer={{ pubkey: PEER, readOnly: false }} />));
    act(() => shared.addMessage(msg({ eventId: 'sig-2', orderId: 'o5', senderPubkey: PEER, payload: { type: 'called' } })));
    expect(host.textContent).toContain('운영자는 보지 않습니다');
    expect(button('운영자 부르기')?.disabled).toBe(false);
  });

  it('끝난 거래는 상대방 칸을 읽기만', () => {
    act(() => root.render(<TradeChat track="ln" orderId="o3" myPubkey={ME} role="customer" peer={{ pubkey: PEER, readOnly: true }} />));
    expect(host.textContent).toContain('상대방(사는 사람)과 대화');
    expect(host.querySelector('textarea')).toBeNull();
  });
});
