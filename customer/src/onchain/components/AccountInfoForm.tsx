import { useState } from 'react';
import { BUTTON } from '@sajwo-tracker/shared';
import {
  ACCOUNT_WINDOW_SEC, canSendAccountInfoOnchain, durationText, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { publishOnchainAccountInfo } from '../nostr/publish';
import { styles } from './card-styles';

/** 고객: 계좌 공개 — 여기서부터 후원자의 송금 시계가 시작된다 (O-013) */
export function AccountInfoForm({ order }: { order: OnchainOrder }) {
  const [bank, setBank] = useState('');
  const [number, setNumber] = useState('');
  const [holder, setHolder] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!order.sponsorPubkey || !bank || !number || !holder) return;
    // 발행 직전에 관문을 한 번 더 본다(O-002·O-003) — 라이트닝 계좌 발행과 같은 자리
    if (!canSendAccountInfoOnchain(order.state)) return;
    setBusy(true);
    try {
      // ⚠️ 필드명은 `AccountInfo`와 **정확히** 같아야 한다 — 다르면 후원자 쪽에서
      // 파싱이 실패해 계좌가 통째로 안 뜬다(2026-09-21에 `accountHolder`로 보내 그랬다).
      await publishOnchainAccountInfo(order.orderId, order.sponsorPubkey, {
        bankName: bank, accountNumber: number, holderName: holder,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>입금받을 계좌 ({durationText(ACCOUNT_WINDOW_SEC)} 안에)</p>
      <p style={styles.warnText}>
        늦으면 거래가 취소되고 <strong>내 보증금이 몰수됩니다.</strong> 계좌는 상대방에게만 암호화되어 전달됩니다.
        틀린 계좌를 주면 상대방이 이의를 내고, 판정에 따라 보증금을 잃을 수 있습니다.
      </p>
      <input style={styles.input} placeholder="은행" value={bank} onChange={e => setBank(e.target.value)} />
      <input style={styles.input} placeholder="계좌번호" value={number} onChange={e => setNumber(e.target.value)} />
      <input style={styles.input} placeholder="예금주" value={holder} onChange={e => setHolder(e.target.value)} />
      <button style={styles.primary} onClick={() => void send()} disabled={busy}>
        {busy ? '보내는 중…' : BUTTON.sendAccount}
      </button>
    </div>
  );
}
