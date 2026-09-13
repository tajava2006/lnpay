/**
 * 채팅 전송 오케스트레이터 (낙관적 렌더링)
 *
 * ── 왜 필요한가
 *
 * 예전에는 전송 버튼을 누르면 릴레이 발행이 끝날 때까지 입력창이 멈췄고, 그 뒤에도
 * 내 메시지가 구독을 타고 되돌아올 때까지 화면에 안 보였다. 체감이 나빴다.
 *
 * 더 나쁜 건 정직성이었다. publishDisputeMessage는 모든 릴레이가 실패해도 throw하지
 * 않는데 호출부가 반환값을 버려서, **발행이 전부 실패해도 입력창이 비워지고 보낸 것처럼
 * 보였다.** 분쟁 채널에서 이건 그냥 버그다.
 *
 * ── 경로는 여전히 하나다
 *
 * 낙관적 렌더링이 흔히 "화면엔 있는데 서버엔 없는" 상태를 만드는 건 상태 표시가
 * 없을 때다. 여기서는:
 *
 * - 서명을 **먼저** 하므로 발행 전에 이미 진짜 eventId를 안다
 * - 그 eventId로 스토어에 넣으므로 릴레이 에코가 도착해도 addMessage가 중복 제거한다
 * - status가 pending/sent/failed를 그대로 말하므로 화면이 거짓말하지 않는다
 *
 * 즉 UI는 예전처럼 스토어만 구독하고, 메시지가 흘러드는 통로도 스토어 하나뿐이다.
 * 달라진 건 스토어에 쓰는 시점이 앞당겨진 것뿐이다.
 */
import type { ChatMessage } from './types';
import { addMessage, setMessageStatus, removeMessage } from './chat-store';

export interface PreparedChatMessage {
  /** 서명까지 끝난 메시지. eventId가 이미 확정돼 있다. */
  message: ChatMessage;
  /** 릴레이 발행. 최소 한 곳이라도 수락하면 true. */
  publish(): Promise<boolean>;
}

/**
 * 메시지를 화면에 먼저 띄우고, 발행은 백그라운드로 돌린다.
 *
 * 반환 Promise는 **서명 + 화면 반영까지만** 기다린다. 호출부(ChatWindow)가 이걸
 * await하면 입력창이 곧바로 비워지면서도, 서명 실패 시에는 입력 내용을 지키게 된다.
 */
export async function sendChatMessage(
  prepare: () => Promise<PreparedChatMessage>,
): Promise<void> {
  // 서명 실패(예: NIP-46 signer 없음)는 호출부로 던져 입력 내용을 보존하게 한다.
  const prepared = await prepare();
  const { orderId, eventId } = prepared.message;

  addMessage({ ...prepared.message, status: 'pending' });

  void prepared.publish()
    .then(ok => setMessageStatus(orderId, eventId, ok ? 'sent' : 'failed'))
    .catch(err => {
      console.warn('[ChatSend] 발행 실패:', eventId, err);
      setMessageStatus(orderId, eventId, 'failed');
    });
}

/**
 * 실패한 메시지를 다시 보낸다.
 *
 * 같은 이벤트를 재발행하지 않고 **새로 서명해 새 메시지로 보낸다** — 실패한 이벤트의
 * 서명본을 들고 있으려면 스토어가 원본을 보관해야 하는데, 재시도는 드물고 텍스트는
 * 이미 payload에 있으므로 그럴 값어치가 없다. 옛 항목은 지워 중복으로 남지 않게 한다.
 */
export async function retryChatMessage(
  failed: ChatMessage,
  prepare: () => Promise<PreparedChatMessage>,
): Promise<void> {
  removeMessage(failed.orderId, failed.eventId);
  try {
    await sendChatMessage(prepare);
  } catch (err) {
    // 재서명조차 실패하면 원래 항목을 되돌려 놓는다 — 조용히 사라지면 안 된다.
    addMessage({ ...failed, status: 'failed' });
    throw err;
  }
}
