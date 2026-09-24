/**
 * 라이트닝 의뢰 하나만 보는 화면 — 어느 탭에서 들어와도 같다
 *
 * 위는 목록과 **같은 카드**(할 일이 전부 거기 있다), 아래는 진행도 전체와 에스크로 채팅. 예전엔 여기에
 * 진행도·채팅만 있어서, 내 거래에서 들어오면 결제할 수 없었다(2026-09-24 드릴).
 *
 * URL에 오더가 남는다(`?order=`) — 새로고침·알림 클릭이 이 화면으로 돌아온다.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  ChatWindow, OrderProgress, addMessage, clearMessages, getChatSnapshot, idbGetOrder, loadFromIdb,
  retryChatMessage, sendChatMessage, subscribeChatMessages, subscribeChatStore,
  type ChatMessage, type DisputeMessagePayload, type Order, type PriceTracker,
} from '@sajwo-tracker/shared';
import { prepareDisputeMessage } from '../buyer/nostr/publish';
import { LnOrderCard } from './LnOrderCard';
import { useLnCard } from './use-ln-card';

interface Props {
  orderId: string;
  onBack: () => void;
  tracker: PriceTracker;
}

export function LnOrderDetail({ orderId, onBack, tracker }: Props) {
  // 라이브 스토어에 없으면(보존 끝) IDB 사본으로 그린다
  const [archived, setArchived] = useState<Order | null>(null);
  useEffect(() => {
    void idbGetOrder(orderId).then(o => { if (o) setArchived(o); });
  }, [orderId]);

  const { view, myPubkey } = useLnCard(orderId, archived);

  useEffect(() => {
    let cleanup: (() => void) | null = null;
    void loadFromIdb(orderId);
    void subscribeChatMessages(orderId, msg => addMessage(msg)).then(unsub => { cleanup = unsub; });
    return () => {
      cleanup?.();
      clearMessages(orderId);
    };
  }, [orderId]);

  const messages = useSyncExternalStore(subscribeChatStore, getChatSnapshot)[orderId] ?? [];

  const handleSend = useCallback(async (text: string) => {
    const payload: DisputeMessagePayload = { type: 'text', content: text };
    await sendChatMessage(() => prepareDisputeMessage({ orderId }, payload));
  }, [orderId]);

  const handleRetry = useCallback(async (failed: ChatMessage) => {
    await retryChatMessage(failed, () => prepareDisputeMessage({ orderId }, failed.payload));
  }, [orderId]);

  return (
    <div style={styles.wrap}>
      <button style={styles.back} onClick={onBack}>← 목록으로</button>

      <LnOrderCard orderId={orderId} archived={archived} tracker={tracker} />

      {view.state && view.role && (
        <OrderProgress
          role={view.role}
          state={view.state}
          accountInfoSent={view.progress.accountInfoSent}
          sponsorDepositPending={view.progress.sponsorDepositPending}
        />
      )}

      {/* 에스크로(운영자)와 나 사이 1:1 — 상대방은 이 대화를 못 본다 */}
      {myPubkey && view.role && !view.draft && (
        <ChatWindow
          label="에스크로 채팅"
          messages={messages}
          myPubkey={myPubkey}
          onSend={handleSend}
          onRetry={handleRetry}
        />
      )}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column' as const, gap: 16 },
  back: {
    alignSelf: 'flex-start' as const, padding: '6px 12px', fontSize: 13, fontWeight: 500 as const, color: '#4F46E5',
    background: 'none', border: '1px solid #C7D2FE', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
  },
};
