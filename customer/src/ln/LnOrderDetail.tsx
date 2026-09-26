/**
 * 라이트닝 의뢰 하나만 보는 화면 — 어느 탭에서 들어와도 같다
 *
 * 위는 목록과 **같은 카드**(할 일이 전부 거기 있다), 아래는 진행도 전체와 에스크로 채팅. 예전엔 여기에
 * 진행도·채팅만 있어서, 내 거래에서 들어오면 결제할 수 없었다(2026-09-24 드릴).
 *
 * URL에 오더가 남는다(`?order=`) — 새로고침·알림 클릭이 이 화면으로 돌아온다. 다른 오더 모음에서 링크(NIP-69
 * `source`)로 들어온 **남**에게는 오더북 카드를 그린다 — 거기서 바로 맡는다.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  CLIENT_TAG, ChatWindow, OrderProgress, addMessage, clearMessages, getChatSnapshot, idbGetOrder, loadFromIdb,
  retryChatMessage, sendChatMessage, sponsorRelation, subscribeChatMessages, subscribeChatStore,
  type ChatMessage, type DisputeMessagePayload, type Order, type PriceTracker,
} from '@sajwo-tracker/shared';
import { isClaimableLn } from '@sajwo-tracker/shared/ln';
import { prepareDisputeMessage } from '../nostr/dispute-message';
import { OrderCard } from '../sponsor/components/OrderCard';
import { ui } from '../ui';
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

  const { view, myPubkey, order, local, now } = useLnCard(orderId, archived);
  // 이 기기에 내 기록이 없는 남의 의뢰. 클레임이 풀린 후원자는 IDB 사본이 있어 내 카드로 본다
  const relation = order && !local && !archived ? sponsorRelation(order, myPubkey) : null;

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
    await sendChatMessage(() => prepareDisputeMessage(orderId, payload, CLIENT_TAG));
  }, [orderId]);

  const handleRetry = useCallback(async (failed: ChatMessage) => {
    await retryChatMessage(failed, () => prepareDisputeMessage(orderId, failed.payload, CLIENT_TAG));
  }, [orderId]);

  return (
    <div style={styles.wrap}>
      <button style={styles.back} onClick={onBack}>← 목록으로</button>

      {order && relation === 'open' && !isClaimableLn(order, now) ? (
        <p style={ui.empty}>기한이 얼마 안 남아 지금은 맡을 수 없는 의뢰입니다.</p>
      ) : order && (relation === 'open' || relation === 'taken') ? (
        <OrderCard order={order} now={now} myPubkey={myPubkey} />
      ) : (
        <LnOrderCard orderId={orderId} archived={archived} tracker={tracker} />
      )}

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
