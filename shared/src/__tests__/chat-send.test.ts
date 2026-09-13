import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sendChatMessage,
  retryChatMessage,
  addMessage,
  getChatSnapshot,
  clearMessages,
} from '../index';
import type { ChatMessage, PreparedChatMessage } from '../index';

// chat-store는 IDB에 fire-and-forget으로 쓴다. node 환경엔 indexedDB가 없으므로
// 그 경로만 막는다 — 여기서 검증하려는 건 인메모리 상태 전이다.
vi.mock('../idb', () => ({
  idbUpsertMessage: vi.fn().mockResolvedValue(undefined),
  idbGetMessagesByOrderId: vi.fn().mockResolvedValue([]),
  idbDeleteMessage: vi.fn().mockResolvedValue(undefined),
}));

const ORDER = 'order-1';

function makeMessage(eventId: string, content = '안녕하세요'): ChatMessage {
  return {
    eventId,
    orderId: ORDER,
    senderPubkey: 'a'.repeat(64),
    recipientPubkey: 'b'.repeat(64),
    payload: { type: 'text', content },
    createdAt: 1_700_000_000,
  };
}

/** publish 완료 시점을 밖에서 조종하는 prepare */
function prepareWith(eventId: string, publish: () => Promise<boolean>) {
  return async (): Promise<PreparedChatMessage> => ({
    message: makeMessage(eventId),
    publish,
  });
}

function messages(): ChatMessage[] {
  return getChatSnapshot()[ORDER] ?? [];
}

beforeEach(() => clearMessages(ORDER));
afterEach(() => clearMessages(ORDER));

describe('sendChatMessage', () => {
  it('발행을 기다리지 않고 곧바로 pending으로 화면에 올린다', async () => {
    let release!: (v: boolean) => void;
    const gate = new Promise<boolean>(r => { release = r; });

    await sendChatMessage(prepareWith('evt-1', () => gate));

    // 발행이 아직 끝나지 않았는데도 이미 보인다 — 입력창이 즉시 비워지는 근거
    expect(messages()).toHaveLength(1);
    expect(messages()[0]!.status).toBe('pending');

    release(true);
    await new Promise(r => setTimeout(r, 0));
    expect(messages()[0]!.status).toBe('sent');
  });

  it('한 릴레이라도 받으면 sent', async () => {
    await sendChatMessage(prepareWith('evt-1', async () => true));
    await new Promise(r => setTimeout(r, 0));
    expect(messages()[0]!.status).toBe('sent');
  });

  // 예전 동작에서는 모든 릴레이가 실패해도 입력창이 비워져 보낸 것처럼 보였다.
  it('발행이 전부 실패하면 failed로 표시한다 — 조용히 성공처럼 보이지 않는다', async () => {
    await sendChatMessage(prepareWith('evt-1', async () => false));
    await new Promise(r => setTimeout(r, 0));
    expect(messages()[0]!.status).toBe('failed');
  });

  it('발행이 예외를 던져도 failed로 떨어진다', async () => {
    await sendChatMessage(prepareWith('evt-1', () => Promise.reject(new Error('릴레이 다운'))));
    await new Promise(r => setTimeout(r, 0));
    expect(messages()[0]!.status).toBe('failed');
  });

  // 서명 실패는 호출부로 던져야 ChatWindow가 입력 내용을 지킬 수 있다.
  it('서명 단계에서 실패하면 던지고 화면에 아무것도 안 남긴다', async () => {
    await expect(
      sendChatMessage(() => Promise.reject(new Error('signer 없음'))),
    ).rejects.toThrow('signer 없음');
    expect(messages()).toHaveLength(0);
  });

  // 낙관적 렌더링이 "경로 두 개"가 되지 않는 근거.
  // 서명을 먼저 하므로 발행 전에 진짜 eventId를 알고, 에코가 같은 id로 돌아온다.
  it('릴레이 에코가 같은 eventId로 돌아와도 중복되지 않는다', async () => {
    await sendChatMessage(prepareWith('evt-1', async () => true));
    await new Promise(r => setTimeout(r, 0));

    addMessage(makeMessage('evt-1')); // 구독이 받은 에코

    expect(messages()).toHaveLength(1);
    expect(messages()[0]!.status).toBe('sent'); // 에코가 상태를 지우지 않는다
  });
});

describe('retryChatMessage', () => {
  it('실패한 항목을 치우고 새 이벤트로 다시 보낸다', async () => {
    await sendChatMessage(prepareWith('evt-1', async () => false));
    await new Promise(r => setTimeout(r, 0));
    expect(messages()[0]!.status).toBe('failed');

    await retryChatMessage(messages()[0]!, prepareWith('evt-2', async () => true));
    await new Promise(r => setTimeout(r, 0));

    expect(messages()).toHaveLength(1); // 옛 항목은 사라졌다
    expect(messages()[0]!.eventId).toBe('evt-2');
    expect(messages()[0]!.status).toBe('sent');
  });

  it('재서명조차 실패하면 원래 항목을 되돌려 놓는다', async () => {
    await sendChatMessage(prepareWith('evt-1', async () => false));
    await new Promise(r => setTimeout(r, 0));
    const failed = messages()[0]!;

    await expect(
      retryChatMessage(failed, () => Promise.reject(new Error('signer 없음'))),
    ).rejects.toThrow('signer 없음');

    // 조용히 사라지면 안 된다
    expect(messages()).toHaveLength(1);
    expect(messages()[0]!.eventId).toBe('evt-1');
    expect(messages()[0]!.status).toBe('failed');
  });
});
