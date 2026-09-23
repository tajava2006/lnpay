/**
 * 온체인 트랙 패널 (PLAN-ONCHAIN-TRACK §9)
 *
 * 어드민이 **분쟁 때만** 손대면 되게 만드는 화면이다. 여기 있는 건:
 *   ① **경보** — 자동 진행도 자동 취소도 위험해 멈춰 선 것들. 사람이 안 오면 안 끝난다
 *   ② **구조** — 약정 밖의 자금(금액 불일치·이중 송금·늦은 펀딩·추가 입금)을 고객에게
 *   ③ **서명 대기** — 결정된 종결을 상대가 서명해야 끝나는 것들 (다시 보내기)
 *   ④ **계좌 이의 판정** — 누구 과실인지 가른다 (§5.2b)
 *   ⑤ **분쟁 판정** — 유일하게 판단이 필요한 자리
 *
 * ⚠️ 판정 버튼 옆에 §7.7을 그대로 적어둔다. **어드민은 애매한 순간에 이 화면을
 * 본다** — 거기 적힌 기본값이 곧 실제 판정이 된다.
 *
 * ⚠️ **판정은 되돌릴 수 없다**(리뷰 #8). 보증금이 판정 시점에 처리되고, 이긴 쪽에게
 * 서명 요청이 나간다. 전에는 두 버튼이 확인창도 맥락도 없이 나란히 있었다.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  APP_PUBKEY, CLIENT_TAG_ONCHAIN, ChatWindow, addMessage, clearMessages, getChatSnapshot,
  loadFromIdb, retryChatMessage, sendChatMessage, subscribeChatStore,
  type ChatMessage, type DisputeMessagePayload,
} from '@sajwo-tracker/shared';
import {
  OUTCOME_RULES, awaitingSignerFor, onchainStateDisplay, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import {
  clearOnchainAlert, getOnchainAlertsSnapshot, getOnchainRescueAlertsSnapshot,
  subscribeOnchainAlerts,
} from '../onchain/alert-store';
import { getSnapshot, subscribe } from '../onchain/order-store';
import { getEscrowMeta } from '../onchain/escrow-meta-store';
import {
  decideOnchainSettlement, requestOnchainRescue, requestSettlementSignature,
  resendReleaseRequest, resolveAccountDispute,
} from '../onchain/service';
import { prepareOnchainDisputeMessage } from '../onchain/publish';
import { subscribeChatMessages } from '../nostr/chat-subscribe';
import { CommitmentBadge } from './CommitmentBadge';

const nowSec = () => Math.floor(Date.now() / 1000);

function hoursLeft(at: number | undefined): string {
  if (!at) return '모름';
  const h = (at - nowSec()) / 3600;
  return h <= 0 ? '이미 만료됐을 수 있음' : `약 ${h.toFixed(1)}시간`;
}

export function OnchainPanel() {
  const orders = useSyncExternalStore(subscribe, getSnapshot);
  const alerts = useSyncExternalStore(subscribeOnchainAlerts, getOnchainAlertsSnapshot);
  const rescues = useSyncExternalStore(subscribeOnchainAlerts, getOnchainRescueAlertsSnapshot);

  const all = Object.values(orders);
  const list = all.filter(o => o.status === 'active');
  const disputes = list.filter(o => o.state === 'disputed');
  // 결정된 종결의 서명을 기다리는 것들 — 오더에 박힌 결정에서 유도한다(기기를 옮겨도 보인다)
  const awaiting = list.filter(o =>
    o.state === 'refunding' || (o.state === 'disputed' && o.settlementKind !== undefined));
  const accountDisputes = all.filter(o => o.settlementKind === 'refund:account-disputed');
  const alertList = Object.values(alerts).sort((a, b) =>
    a.level === b.level ? b.at - a.at : a.level === 'anomaly' ? -1 : 1);
  const rescueList = Object.values(rescues);

  return (
    <section style={styles.panel}>
      <h2 style={styles.heading}>온체인 트랙</h2>

      {alertList.length > 0 && (
        <div style={styles.block}>
          <p style={styles.blockTitle}>경보</p>
          {alertList.map(alert => (
            <div key={alert.orderId} style={alert.level === 'anomaly' ? styles.anomaly : styles.warn}>
              <div>
                <strong>{alert.orderId}</strong>
                <p style={styles.why}>{alert.why}</p>
              </div>
              <button style={styles.ghost} onClick={() => clearOnchainAlert(alert.orderId)}>확인함</button>
            </div>
          ))}
        </div>
      )}

      {rescueList.length > 0 && (
        <div style={styles.block}>
          <p style={styles.blockTitle}>구조 — 약정 밖의 자금을 고객에게</p>
          <p style={styles.note}>
            금액이 틀린 펀딩·이중 송금·취소 뒤 늦은 펀딩·확정 뒤 추가 입금이다. {'{A,C}'} 리프로
            <strong> 고객이 낸 환불 주소</strong>에 돌려준다. 고객이 서명해야 나가고, 어드민은 마지막에 서명한다.
          </p>
          {rescueList.map(r => {
            const order = orders[r.orderId];
            return r.utxos.map(u => (
              <RescueRow key={`${u.txid}:${u.vout}`} order={order} utxo={u} />
            ));
          })}
        </div>
      )}

      {awaiting.length > 0 && (
        <div style={styles.block}>
          <p style={styles.blockTitle}>서명 대기</p>
          {awaiting.map(o => (
            <div key={o.orderId} style={styles.row}>
              <strong>{o.orderId}</strong>
              <span style={styles.meta}>{o.settlementKind}</span>
              <span style={styles.meta}>
                {o.settlementKind && awaitingSignerFor(o.settlementKind) === 'sponsor' ? '후원자' : '고객'} 서명 대기
              </span>
              <button style={styles.ghost} onClick={() => void requestSettlementSignature(o)}>
                다시 보내기
              </button>
            </div>
          ))}
        </div>
      )}

      {accountDisputes.some(o => o.state !== 'cancelled') && (
        <div style={styles.block}>
          <p style={styles.blockTitle}>계좌 이의 판정</p>
          <p style={styles.note}>
            후원자가 송금 마감 전에 "계좌를 쓸 수 없다"고 했고 그대로 마감이 찼다. 환불은 그대로 진행되고,
            <strong> 보증금만</strong> 여기서 갈린다. 입증책임은 몰수를 면하려는 후원자에게 있다(§7.7) — 계좌번호 형식
            오류처럼 <strong>직접 확인할 수 있는 것</strong>이 아니면 인정하지 않는다.
          </p>
          {accountDisputes.map(o => <AccountDisputeRow key={o.orderId} order={o} />)}
        </div>
      )}

      <div style={styles.block}>
        <p style={styles.blockTitle}>진행 중 ({list.length})</p>
        {list.length === 0 && <p style={styles.empty}>없음</p>}
        {list.map(order => {
          const badge = onchainStateDisplay(order.state);
          return (
            <div key={order.orderId} style={styles.row}>
              <span style={{ ...styles.badge, color: badge.color, background: badge.bg }}>
                {badge.label}
              </span>
              <strong>{order.orderId}</strong>
              <span style={styles.meta}>{order.amountSat.toLocaleString()} sats</span>
              {order.priceKrw !== undefined && (
                <span style={styles.meta}>{order.priceKrw.toLocaleString()}원</span>
              )}
              {(order.state === 'presigned' || order.state === 'remitted' || order.state === 'disputed') && (
                <button
                  style={styles.ghost}
                  title="고객이 릴리스 PSBT를 못 받았을 때"
                  onClick={() => void resendReleaseRequest(order).catch(e => alert(String(e)))}
                >
                  릴리스 PSBT 다시 보내기
                </button>
              )}
            </div>
          );
        })}
      </div>

      {disputes.length > 0 && (
        <div style={styles.block}>
          <p style={styles.blockTitle}>분쟁 판정 ({disputes.length})</p>
          <div style={styles.guide}>
            <strong>기본 승자는 없다.</strong> 오판의 비용이 양쪽 같다 — 잘못된
            후원자승은 고객이 원화 없이 BTC를 잃고, 잘못된 고객승은 후원자가
            원화를 내고 BTC를 못 받는다.
            <ol style={styles.guideList}>
              <li><strong>자금을 움직여 달라는 쪽이 먼저 증명한다</strong> (후원자).</li>
              <li>금액·수취인명·시각이 맞는 이체 내역이면 책임이 고객에게 넘어간다.</li>
              <li><strong>증거 제출을 거부하는 쪽에 불리하게</strong> 본다. 침묵은 패소가 아니다.</li>
              <li>정면 충돌이면 은행 기록을 정밀 대조하고, 안 갈리면 보류 후 에스컬레이션.</li>
            </ol>
            중재료는 <strong>패소자의 몰수 보증금에서</strong> 나간다 — 분쟁 tx에 출력을 달지 않는다.
            <br />⚠️ 몰수는 <strong>판정 시점</strong>에 집행된다. 보증금이 만료되기 전에 판정해야 한다.
          </div>
          {disputes.map(order => <DisputeCard key={order.orderId} order={order} />)}
        </div>
      )}
    </section>
  );
}

function RescueRow({ order, utxo }: {
  order: OnchainOrder | undefined;
  utxo: { txid: string; vout: number; valueSat: number };
}) {
  const [status, setStatus] = useState<string | null>(null);
  if (!order) return null;
  return (
    <div style={styles.row}>
      <strong>{order.orderId}</strong>
      <span style={styles.meta}>{utxo.valueSat.toLocaleString()} sats</span>
      <code style={styles.code}>{utxo.txid.slice(0, 12)}…:{utxo.vout}</code>
      <button
        style={styles.decide}
        onClick={() => {
          if (!confirm(
            `${utxo.valueSat.toLocaleString()} sats를 고객 환불 주소로 돌려보내는 서명 요청을 보냅니다.\n`
            + '고객이 서명하면 어드민이 서명해 바로 브로드캐스트합니다. 진행할까요?',
          )) return;
          setStatus('보내는 중…');
          void requestOnchainRescue(order, utxo).then(err => setStatus(err ?? '고객에게 요청을 보냈다'));
        }}
      >
        고객에게 돌려주기
      </button>
      {status && <span style={styles.meta}>{status}</span>}
    </div>
  );
}

function AccountDisputeRow({ order }: { order: OnchainOrder }) {
  const decide = (verdict: 'account-bad' | 'sponsor-fault') => {
    const text = verdict === 'account-bad'
      ? '계좌 문제를 인정합니다 → 고객 보증금 몰수, 후원자 보증금 환불.'
      : '계좌 이의를 인정하지 않습니다 → 후원자 보증금 몰수, 고객 보증금 환불.';
    if (!confirm(`${order.orderId}\n\n${text}\n\n되돌릴 수 없습니다. 진행할까요?`)) return;
    void resolveAccountDispute(order, verdict);
  };
  return (
    <div style={styles.card}>
      <div style={styles.row}>
        <strong>{order.orderId}</strong>
        <span style={styles.meta}>{onchainStateDisplay(order.state).label}</span>
        <span style={styles.meta}>
          이의 {order.accountDisputedAt ? new Date(order.accountDisputedAt * 1000).toLocaleString('ko-KR') : '?'}
        </span>
      </div>
      <OnchainDisputeChat order={order} />
      <div style={styles.row}>
        <button style={styles.decide} onClick={() => decide('account-bad')}>계좌 문제 인정 (고객 몰수)</button>
        <button style={styles.decide} onClick={() => decide('sponsor-fault')}>인정 안 함 (후원자 몰수)</button>
      </div>
    </div>
  );
}

function DisputeCard({ order }: { order: OnchainOrder }) {
  const [busy, setBusy] = useState(false);
  const meta = getEscrowMeta(order.orderId);
  const ruled = order.settlementKind;

  const rule = (kind: 'sponsor_win' | 'customer_win') => {
    const r = OUTCOME_RULES[kind];
    const summary = kind === 'sponsor_win'
      ? `후원자 승 — BTC ${order.amountSat.toLocaleString()} sats가 후원자에게 간다. 고객 보증금 몰수.`
      : `고객 승 — BTC ${order.amountSat.toLocaleString()} sats가 고객에게 돌아간다. 후원자 보증금 몰수.`;
    if (!confirm(
      `${order.orderId}\n\n${summary}\n(${r.label})\n\n`
      + '⚠️ 판정은 되돌릴 수 없다. 보증금이 지금 처리되고 이긴 쪽에게 서명 요청이 나간다.\n'
      + '증거를 대조했는가?',
    )) return;
    setBusy(true);
    void decideOnchainSettlement(order, kind)
      .then(updated => { if (!updated) alert('판정을 기록하지 못했다 (수수료 조회 실패 또는 상태가 바뀜)'); })
      .finally(() => setBusy(false));
  };

  return (
    <div style={styles.card}>
      <div style={styles.row}>
        <strong>{order.orderId}</strong>
        <span style={styles.meta}>{order.amountSat.toLocaleString()} sats</span>
        {order.priceKrw !== undefined && <span style={styles.meta}>{order.priceKrw.toLocaleString()}원</span>}
      </div>
      <div style={styles.facts}>
        <span>송금 주장: {order.remittedAt ? new Date(order.remittedAt * 1000).toLocaleString('ko-KR') : '—'}</span>
        <span>분쟁 진입: {order.disputedAt ? new Date(order.disputedAt * 1000).toLocaleString('ko-KR') : '—'}</span>
        <span>고객 보증금 만료까지: {hoursLeft(meta?.customerBondExpiresAt)}</span>
        <span>후원자 보증금 만료까지: {hoursLeft(meta?.sponsorBondExpiresAt)}</span>
      </div>
      <OnchainDisputeChat order={order} />
      {ruled ? (
        <p style={styles.note}>
          판정: <strong>{OUTCOME_RULES[ruled].label}</strong> — 이긴 쪽의 서명을 기다린다.
        </p>
      ) : (
        <div style={styles.row}>
          <button style={styles.decide} disabled={busy} onClick={() => rule('sponsor_win')}>후원자 승</button>
          <button style={styles.decide} disabled={busy} onClick={() => rule('customer_win')}>고객 승</button>
        </div>
      )}
    </div>
  );
}

/**
 * 온체인 분쟁 채팅 — 고객·후원자 각각과.
 *
 * 전에는 없었다. 알림은 "증거를 채팅에 올려주세요"라고 보내는데 채팅이 라이트닝
 * 태그로만 돌아 온체인 주문에는 창이 없었다(리뷰 #8).
 */
function OnchainDisputeChat({ order }: { order: OnchainOrder }) {
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
  if (!open) {
    return <button style={styles.ghost} onClick={() => setOpen(true)}>채팅·증거 열기</button>;
  }

  const messages = chat[order.orderId] ?? [];
  // 후원자가 공개한 계좌가 고객이 실제로 보낸 것인지 — 고객 이벤트의 커밋먼트와 대조한다.
  const commitment = getEscrowMeta(order.orderId)?.accountCommitment;
  const withPeer = (peer: string | undefined) =>
    messages.filter(m => m.senderPubkey === peer || m.recipientPubkey === peer);
  const send = (peer: string) => async (text: string) => {
    const payload: DisputeMessagePayload = { type: 'text', content: text };
    await sendChatMessage(() => prepareOnchainDisputeMessage(order.orderId, peer, payload));
  };
  const retry = (peer: string) => async (failed: ChatMessage) => {
    await retryChatMessage(failed, () => prepareOnchainDisputeMessage(order.orderId, peer, failed.payload));
  };

  return (
    <div style={styles.chats}>
      <ChatWindow
        label="고객"
        messages={withPeer(order.customerPubkey)}
        myPubkey={APP_PUBKEY}
        onSend={send(order.customerPubkey)}
        onRetry={retry(order.customerPubkey)}
      />
      {order.sponsorPubkey && (
        <ChatWindow
          label="후원자"
          messages={withPeer(order.sponsorPubkey)}
          myPubkey={APP_PUBKEY}
          onSend={send(order.sponsorPubkey)}
          onRetry={retry(order.sponsorPubkey)}
          renderAccountExtra={commitment
            ? (info, salt) => <CommitmentBadge accountInfo={info} commitment={commitment} salt={salt} />
            : undefined}
        />
      )}
    </div>
  );
}

const styles = {
  panel: { border: '1px solid #E5E7EB', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column' as const, gap: 14 },
  heading: { margin: 0, fontSize: 16 },
  block: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  blockTitle: { margin: 0, fontSize: 13, fontWeight: 600 as const, color: '#374151' },
  empty: { margin: 0, fontSize: 13, color: '#9CA3AF' },
  note: { margin: 0, fontSize: 12, color: '#4B5563', lineHeight: 1.6 },
  row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '6px 0', borderBottom: '1px solid #F3F4F6', flexWrap: 'wrap' as const },
  card: { display: 'flex', flexDirection: 'column' as const, gap: 8, border: '1px solid #E5E7EB', borderRadius: 8, padding: '10px 12px' },
  facts: { display: 'flex', flexWrap: 'wrap' as const, gap: 12, fontSize: 12, color: '#4B5563' },
  chats: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  meta: { fontSize: 12, color: '#6B7280' },
  code: { fontSize: 11, color: '#6B7280' },
  badge: { fontSize: 11, fontWeight: 600 as const, padding: '2px 6px', borderRadius: 4 },
  anomaly: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 10px', color: '#991B1B' },
  warn: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '8px 10px', color: '#9A3412' },
  why: { margin: '2px 0 0', fontSize: 12, lineHeight: 1.5 },
  ghost: { padding: '5px 10px', fontSize: 12, background: '#fff', border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer' },
  decide: { padding: '6px 12px', fontSize: 12, fontWeight: 600 as const, background: '#111827', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' },
  guide: { background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#374151', lineHeight: 1.7 },
  guideList: { margin: '6px 0', paddingLeft: 18, display: 'flex', flexDirection: 'column' as const, gap: 3 },
};
