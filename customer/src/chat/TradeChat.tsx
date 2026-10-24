/**
 * 거래 상세의 대화 — 상대방 칸 + 운영자 칸 (docs/PLAN-PEER-CHAT.md §8) · 두 트랙 공용
 *
 * 예전엔 대화창이 하나였고 그게 **운영자와의 1:1**이었다. 유저는 상대방과 대화하는 줄 알았다(2026-10-24 피드백). 참고한
 * RoboSats처럼 기본은 상대방과 대화하고, 운영자는 **부를 때만** 온다:
 *
 * - **상대방 칸** — 상대가 정해진 뒤에만. 두 사람만 읽는 암호문이라 운영자도 못 본다(`shared/peer-chat.ts`).
 * - **운영자 칸** — 평소엔 없다. "운영자 부르기"를 누르거나 운영자가 먼저 말을 걸면(메시지가 하나라도 있으면) 열린다.
 *   운영자는 당사자마다 따로 대화한다 — 상대방은 이 칸을 못 본다.
 * - **부르기** — 사유와 이 거래의 대화 키를 보낸다. 운영자가 두 사람 대화를 읽기만 하게 된다(한 번 공개하면 되돌릴 수 없다).
 *   대화 키는 두 사람이 같아서 **한 사람이 부르면 끝**이다 — 상대 앱에는 데몬이 `called` 신호를 보내고(말풍선이 아니다),
 *   두 앱 모두 상대방 칸 안내를 "운영자도 봅니다"로 바꾸고 다시 부르기를 잠근다(2026-10-24 메인넷 확인 피드백).
 *
 * 채팅 스토어 하나에 두 대화가 같이 들어온다(`channel`로 가른다). 구독은 이 화면에 있는 동안만 연다.
 */
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  APP_PUBKEY, BUTTON, ChatWindow, addMessage, clearMessages, getChatSnapshot, loadFromIdb, retryChatMessage, sendChatMessage,
  subscribeChatMessages, subscribeChatStore, subscribePeerMessages, trackTagOf,
  type ChatMessage, type TrackName,
} from '@sajwo-tracker/shared';
import { Modal } from '../components/Modal';
import { prepareDisputeMessage } from '../nostr/dispute-message';
import { prepareOperatorCall, preparePeerMessage } from '../nostr/peer-message';
import { ui } from '../ui';

/** 상대방 칸 — 상대 pubkey와, 끝난 거래라 읽기만 하는지 */
export interface PeerChatView {
  pubkey: string;
  readOnly: boolean;
}

interface Props {
  track: TrackName;
  orderId: string;
  myPubkey: string;
  role: 'customer' | 'sponsor';
  /** null이면 상대방 칸이 없다(아직 상대가 없다) */
  peer: PeerChatView | null;
  /** 정식 분쟁 중 — 부르기를 눈에 띄게 둔다 */
  dispute?: boolean;
  /** 운영자 칸 아래 덧붙일 것 — 온체인 사는 사람의 "받은 계좌를 증거로 공개" */
  operatorExtra?: ReactNode;
}

const EMPTY: ChatMessage[] = [];

export function TradeChat({ track, orderId, myPubkey, role, peer, dispute = false, operatorExtra }: Props) {
  const [loadError, setLoadError] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const peerPubkey = peer?.pubkey ?? null;
  const trackTag = trackTagOf(track);

  useEffect(() => {
    let alive = true;
    const stops: Array<() => void> = [];
    const keep = (stop: () => void) => { if (alive) stops.push(stop); else stop(); };
    const fail = (err: unknown) => {
      console.warn('[TradeChat] 대화 구독 실패', err);
      if (alive) setLoadError(true);
    };
    void loadFromIdb(orderId);
    void subscribeChatMessages(orderId, addMessage, trackTag).then(keep, fail);
    if (peerPubkey) {
      const parties = role === 'customer'
        ? { customer: myPubkey, sponsor: peerPubkey }
        : { customer: peerPubkey, sponsor: myPubkey };
      void subscribePeerMessages({ track, orderId, parties }, addMessage).then(keep, fail);
    }
    return () => {
      alive = false;
      for (const stop of stops) stop();
      clearMessages(orderId);
    };
  }, [track, trackTag, orderId, myPubkey, role, peerPubkey]);

  const all = useSyncExternalStore(subscribeChatStore, getChatSnapshot)[orderId] ?? EMPTY;
  const peerMessages = all.filter(m => m.channel === 'peer');
  // `called`는 말풍선이 아니라 상태다 — 운영자 칸에서 빼고(그 칸을 열지도 않는다), 데몬(APP)이 보낸 것만 믿는다
  const operatorMessages = all.filter(m => m.channel !== 'peer' && m.payload.type !== 'called');
  // 누가 대화 키를 넘겼나 — 상대가 없을 때 부른 건 대화를 공개하지 않았다
  const disclosedBy: Disclosure = operatorMessages.some(m => m.senderPubkey === myPubkey && m.payload.type === 'call' && !!m.payload.peerChatKey)
    ? 'me'
    : all.some(m => m.channel !== 'peer' && m.payload.type === 'called' && m.senderPubkey === APP_PUBKEY) ? 'peer' : null;

  const sendPeer = useCallback(async (text: string) => {
    if (!peerPubkey) return;
    await sendChatMessage(() => preparePeerMessage({ track, orderId, peerPubkey }, text));
  }, [track, orderId, peerPubkey]);

  const retryPeer = useCallback(async (failed: ChatMessage) => {
    if (!peerPubkey) return;
    await retryChatMessage(failed, () => preparePeerMessage({ track, orderId, peerPubkey }, failed.payload.content ?? ''));
  }, [track, orderId, peerPubkey]);

  const sendOperator = useCallback(async (text: string) => {
    await sendChatMessage(() => prepareDisputeMessage(orderId, { type: 'text', content: text }, trackTag));
  }, [orderId, trackTag]);

  // 실패한 부르기도 같은 payload(대화 키 포함)로 다시 보낸다
  const retryOperator = useCallback(async (failed: ChatMessage) => {
    await retryChatMessage(failed, () => prepareDisputeMessage(orderId, failed.payload, trackTag));
  }, [orderId, trackTag]);

  const call = useCallback(async (reason: string) => {
    await sendChatMessage(() => prepareOperatorCall({ track, orderId, peerPubkey }, reason));
  }, [track, orderId, peerPubkey]);

  const peerName = role === 'customer' ? '사는 사람' : '파는 사람';
  const canDisclose = !!peerPubkey && disclosedBy === null;
  const showCall = disclosedBy === null && (operatorMessages.length === 0 || canDisclose);

  return (
    <div style={styles.wrap}>
      {loadError && <p style={ui.errorText}>대화를 불러오지 못했습니다. 새로고침해 주세요.</p>}

      {peer && (
        <ChatWindow
          variant="peer"
          label={`상대방(${peerName})과 대화 — ${disclosedBy ? '운영자도 봅니다' : '운영자는 보지 않습니다'}`}
          notice={<PeerNotice track={track} role={role} disclosedBy={disclosedBy} />}
          readOnly={peer.readOnly}
          emptyText={peer.readOnly ? '나눈 대화가 없습니다' : `거래에 필요한 이야기를 ${peerName}과 여기서 나누세요`}
          messages={peerMessages}
          myPubkey={myPubkey}
          onSend={sendPeer}
          onRetry={retryPeer}
        />
      )}

      {operatorMessages.length > 0 && (
        <>
          <ChatWindow
            variant="operator"
            label="운영자와 대화 — 상대방은 보지 않습니다"
            notice="운영자는 두 분과 따로 대화합니다. 여기서 한 말은 상대방에게 보이지 않습니다."
            messages={operatorMessages}
            myPubkey={myPubkey}
            onSend={sendOperator}
            onRetry={retryOperator}
          />
          {operatorExtra}
        </>
      )}

      {disclosedBy === 'peer' && operatorMessages.length === 0 && (
        // 대화 키가 같아 또 불러도 바뀌는 게 없다 — 잠가 두고 왜 잠겼는지 말한다
        <div style={styles.callBox}>
          <button type="button" style={ui.ghostButton} disabled>운영자 부르기</button>
          <span style={styles.callHint}>상대방이 이미 운영자를 불렀습니다. 하실 말씀은 상대방과의 대화에 남기면 운영자도 봅니다.</span>
        </div>
      )}

      {showCall && (
        <div style={dispute ? styles.callBoxStrong : styles.callBox}>
          {dispute && (
            <p style={styles.callLead}>
              분쟁이 열렸습니다. 운영자를 부르면 상대방과 나눈 대화가 판정에 참고됩니다.
            </p>
          )}
          <button type="button" style={dispute ? ui.primaryButton : ui.ghostButton} onClick={() => setCallOpen(true)}>
            {operatorMessages.length === 0 ? '운영자 부르기' : '운영자에게 상대방과의 대화 보여주기'}
          </button>
          {!dispute && operatorMessages.length === 0 && (
            <span style={styles.callHint}>문제가 생겼을 때만 — 운영자는 평소 이 거래에 없습니다.</span>
          )}
        </div>
      )}

      {callOpen && <CallOperatorDialog hasPeer={!!peerPubkey} onClose={() => setCallOpen(false)} onCall={call} />}
    </div>
  );
}

/** 누가 대화 키를 넘겨 운영자를 불렀나 */
type Disclosure = 'me' | 'peer' | null;

/** 상대방 칸 위 고정 안내 — 채팅이 생기면 생기는 사기 수법을 막는다(docs/RISKS.md) */
function PeerNotice({ track, role, disclosedBy }: { track: TrackName; role: 'customer' | 'sponsor'; disclosedBy: Disclosure }) {
  const confirm = track === 'ln' ? `'${BUTTON.confirmPaid}'을` : `'${BUTTON.confirmReleased}'를`;
  return (
    <ul style={styles.noticeList}>
      {disclosedBy && (
        <li style={styles.disclosed}>
          {disclosedBy === 'me' ? '운영자를 불렀습니다' : '상대방이 운영자를 불렀습니다'} — 이제 운영자가 이 대화를 처음부터 전부 볼 수
          있습니다.
        </li>
      )}
      {role === 'customer' ? (
        <>
          <li>계좌는 '{BUTTON.sendAccount}'로만 보내세요. 채팅으로 보낸 계좌는 분쟁에서 인정되지 않습니다.</li>
          <li>입금은 반드시 내 은행 앱에서 직접 확인하세요. 상대가 보냈다고 해도 확인 전에는 {confirm} 누르지 마세요.</li>
        </>
      ) : (
        <li>계좌는 '{BUTTON.sendAccount}'로 받은 것만 유효합니다. 채팅으로 받은 계좌로 보내면 분쟁에서 인정되지 않습니다.</li>
      )}
      <li>에스크로 밖에서 거래하자는 제안이나 외부 링크는 사기일 수 있습니다.</li>
    </ul>
  );
}

function CallOperatorDialog({ hasPeer, onClose, onCall }: {
  hasPeer: boolean;
  onClose: () => void;
  onCall: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const text = reason.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCall(text);
      onClose();
    } catch (err) {
      console.warn('[TradeChat] 운영자 부르기 실패', err);
      setError('운영자를 부르지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="운영자 부르기" onClose={onClose}>
      <p style={ui.text}>운영자는 평소 이 거래에 없습니다. 문제가 생겼을 때만 불러 주세요.</p>
      {hasPeer && (
        <p style={ui.tipBox}>
          <b>부르면 이 거래에서 상대방과 나눈 대화를 운영자가 읽을 수 있게 됩니다.</b> 상대방에게도 알림이 갑니다.
          한 번 공개하면 되돌릴 수 없습니다. (운영자가 볼 수 있는 건 이 거래의 대화뿐입니다.)
        </p>
      )}
      <p style={ui.text}>운영자는 부른 분과 따로 대화합니다. 그 대화는 상대방에게 보이지 않습니다.</p>
      <label style={styles.label}>
        무슨 일인가요? (필수)
        <textarea
          style={styles.textarea}
          rows={3}
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="예: 송금했다는데 입금이 안 들어왔어요"
        />
      </label>
      {error && <p style={ui.errorText}>{error}</p>}
      <div style={styles.buttons}>
        <button type="button" style={ui.primaryButton} disabled={busy || !reason.trim()} onClick={() => void submit()}>
          {busy ? '부르는 중…' : '운영자 부르기'}
        </button>
        <button type="button" style={ui.ghostButton} disabled={busy} onClick={onClose}>취소</button>
      </div>
    </Modal>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column' as const, gap: 12 },
  noticeList: { margin: 0, paddingLeft: 16 },
  disclosed: { fontWeight: 700 as const, color: '#92400E' },
  callBox: { display: 'flex', flexWrap: 'wrap' as const, alignItems: 'center', gap: 8 },
  callBoxStrong: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-start', gap: 8, padding: 12,
    background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8,
  },
  callLead: { margin: 0, fontSize: 13, lineHeight: 1.6, color: '#92400E' },
  callHint: { fontSize: 12, color: '#9CA3AF' },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 6, fontSize: 13, fontWeight: 600 as const, color: '#374151' },
  textarea: {
    padding: '8px 10px', fontSize: 13, border: '1px solid #D1D5DB', borderRadius: 6, fontFamily: 'inherit', resize: 'vertical' as const,
  },
  buttons: { display: 'flex', gap: 8, marginTop: 12 },
};
