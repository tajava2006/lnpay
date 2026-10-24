/**
 * 온체인 사는 사람 — 받은 계좌를 운영자에게 증거로 공개 (예전 `OnchainChat`에서 옮겨 왔다)
 *
 * 계좌와 솔트를 같이 보내면 운영자가 파는 사람 이벤트의 공개 커밋먼트와 대조한다(계좌 이의 판정의 근거). 운영자 칸이
 * 열렸을 때(불렀거나 운영자가 말을 걸었을 때) 그 아래 뜬다 — 운영자에게만 가는 것이라 상대방 칸과는 상관없다.
 */
import { useState } from 'react';
import { CLIENT_TAG_ONCHAIN, sendChatMessage, type DisputeMessagePayload } from '@sajwo-tracker/shared';
import { prepareDisputeMessage } from '../../nostr/dispute-message';
import { getOnchainAccount } from '../account-store';
import { ui } from '../../ui';

export function OnchainAccountReveal({ orderId }: { orderId: string }) {
  const [error, setError] = useState<string | null>(null);
  const account = getOnchainAccount(orderId);
  if (!account) return null;

  async function reveal(found: NonNullable<typeof account>) {
    if (!confirm('받은 계좌 정보를 운영자에게 공개합니다. 운영자가 상대방이 보낸 원본과 대조합니다.')) return;
    const payload: DisputeMessagePayload = {
      type: 'account-reveal',
      accountInfo: found.accountInfo,
      commitmentSalt: found.salt || undefined,
    };
    try {
      setError(null);
      await sendChatMessage(() => prepareDisputeMessage(orderId, payload, CLIENT_TAG_ONCHAIN));
    } catch (err) {
      console.warn('[온체인] 계좌 공개 실패', err);
      setError('계좌를 공개하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  }

  return (
    <>
      <button type="button" style={ui.ghostButton} onClick={() => void reveal(account)}>받은 계좌를 증거로 공개</button>
      {error && <p style={ui.errorText}>{error}</p>}
    </>
  );
}
