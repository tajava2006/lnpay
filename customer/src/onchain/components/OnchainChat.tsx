/**
 * 온체인 분쟁 채팅 (나 ↔ 운영자)
 *
 * 전에는 없었다 — 분쟁 알림은 "증거를 채팅에 올려주세요"라고 하는데 채팅은
 * 라이트닝 태그로만 돌았다. 입증책임은 증거가 오갈 길이 있어야
 * 작동한다.
 *
 * 후원자는 **받은 계좌를 증거로 공개**할 수 있다 — 계좌와 솔트를 같이 보내면
 * 운영자가 고객 이벤트의 공개 커밋먼트와 대조한다(계좌 이의 판정의 근거).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  CLIENT_TAG_ONCHAIN, ChatWindow, addMessage, clearMessages, getChatSnapshot, loadFromIdb,
  retryChatMessage, sendChatMessage, subscribeChatMessages, subscribeChatStore,
  type ChatMessage, type DisputeMessagePayload,
} from '@sajwo-tracker/shared';
import type { OnchainOrder } from '@sajwo-tracker/shared/onchain';
import { prepareDisputeMessage } from '../../nostr/dispute-message';
import { getOnchainAccount } from '../account-store';

export function OnchainChat({ order, myPubkey, role }: {
  order: OnchainOrder;
  myPubkey: string;
  role: 'customer' | 'sponsor';
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cleanup: (() => void) | null = null;
    void loadFromIdb(order.orderId);
    void subscribeChatMessages(order.orderId, msg => addMessage(msg), CLIENT_TAG_ONCHAIN)
      .then(unsub => { cleanup = unsub; });
    return () => {
      cleanup?.();
      clearMessages(order.orderId);
    };
  }, [open, order.orderId]);

  const chat = useSyncExternalStore(subscribeChatStore, getChatSnapshot);

  const send = useCallback(async (text: string) => {
    const payload: DisputeMessagePayload = { type: 'text', content: text };
    await sendChatMessage(() => prepareDisputeMessage(order.orderId, payload, CLIENT_TAG_ONCHAIN));
  }, [order.orderId]);

  const retry = useCallback(async (failed: ChatMessage) => {
    await retryChatMessage(failed, () => prepareDisputeMessage(order.orderId, failed.payload, CLIENT_TAG_ONCHAIN));
  }, [order.orderId]);

  if (!open) {
    return (
      <button style={styles.toggle} onClick={() => setOpen(true)}>
        운영자와 채팅 · 증거 올리기
      </button>
    );
  }

  const account = role === 'sponsor' ? getOnchainAccount(order.orderId) : undefined;

  return (
    <div style={styles.wrap}>
      <ChatWindow
        label="운영자"
        messages={chat[order.orderId] ?? []}
        myPubkey={myPubkey}
        onSend={send}
        onRetry={retry}
      />
      {account && (
        <button
          style={styles.toggle}
          onClick={() => {
            if (!confirm('받은 계좌 정보를 운영자에게 공개합니다. 운영자가 상대방이 보낸 원본과 대조합니다.')) return;
            const payload: DisputeMessagePayload = {
              type: 'account-reveal',
              accountInfo: account.accountInfo,
              commitmentSalt: account.salt || undefined,
            };
            void sendChatMessage(() => prepareDisputeMessage(order.orderId, payload, CLIENT_TAG_ONCHAIN));
          }}
        >
          받은 계좌를 증거로 공개
        </button>
      )}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  toggle: { padding: '8px', fontSize: 13, background: '#fff', color: '#374151', border: '1px solid #D1D5DB', borderRadius: 8, cursor: 'pointer' },
};
