/**
 * 온체인 의뢰 등록 (고객)
 *
 * 라이트닝과 다른 점: **수량(sats)을 정한다.** 가격은 여기서 안 정한다 —
 * 펀딩이 컨펌되는 시점의 시세로 정해진다(§2.4). 그래야 아무도 공짜 옵션을
 * 쥐지 않는다.
 *
 * 대신 **최저가(reserve)** 로 아래쪽을 막는다. 한 달 방치된 시장가 주문은
 * 플래시 크래시에 그대로 노출되기 때문이다.
 */
import { useState } from 'react';
import { MAX_ORDER_EXPIRY_SEC } from '@sajwo-tracker/shared/onchain';
import { myOrderXonly } from '../keys';
import { publishOnchainOrderRequest } from '../nostr/publish';
import { rememberPendingRequest } from '../pending-request-store';

const DAY = 86_400;

function newOrderId(): string {
  return `oc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function OnchainOrderForm({ onDone }: { onDone?: () => void }) {
  const [amountSat, setAmountSat] = useState('');
  const [reserveKrw, setReserveKrw] = useState('');
  const [days, setDays] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const sats = Number(amountSat);
    if (!Number.isInteger(sats) || sats <= 0) {
      return setError('수량을 sats 단위 정수로 입력하세요.');
    }
    const reserve = reserveKrw ? Number(reserveKrw) : undefined;
    if (reserve !== undefined && (!Number.isFinite(reserve) || reserve <= 0)) {
      return setError('최저가는 원 단위 숫자여야 합니다.');
    }

    setBusy(true);
    try {
      const orderId = newOrderId();
      const customerXonly = await myOrderXonly(orderId);
      const expiration = Math.floor(Date.now() / 1000) + days * DAY;
      const result = await publishOnchainOrderRequest({
        orderId, amountSat: sats, reserveKrw: reserve, customerXonly, expiration,
      });
      if (!result.success) {
        setError('발행에 실패했습니다. 잠시 후 다시 시도하세요.');
        return;
      }
      // ⚠️ **보낸 요청을 적어둔다.** 오더는 보증금을 결제해야 생기므로, 그 전에
      // 어드민이 거절하거나 실패하면 유저 쪽에 흔적이 하나도 안 남는다.
      rememberPendingRequest({
        orderId, amountSat: sats, reserveKrw: reserve, expiration,
        submittedAt: Math.floor(Date.now() / 1000),
      });
      setAmountSat('');
      setReserveKrw('');
      onDone?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.form}>
      <label style={styles.label}>
        팔 수량 (sats)
        <input
          style={styles.input}
          inputMode="numeric"
          value={amountSat}
          onChange={e => setAmountSat(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="500000"
        />
      </label>

      <label style={styles.label}>
        최저가 (원, 선택)
        <input
          style={styles.input}
          inputMode="numeric"
          value={reserveKrw}
          onChange={e => setReserveKrw(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="비우면 시장가"
        />
        <span style={styles.hint}>
          펀딩이 컨펌되는 시점 시세가 이보다 낮으면 거래가 취소되고 에스크로가 돌아옵니다.
        </span>
      </label>

      <label style={styles.label}>
        유효 기간
        <select
          style={styles.input}
          value={days}
          onChange={e => setDays(Number(e.target.value))}
        >
          {[1, 2, 3, 5, 7].map(d => <option key={d} value={d}>{d}일</option>)}
        </select>
        <span style={styles.hint}>
          최대 {MAX_ORDER_EXPIRY_SEC / DAY}일. 그 안에 후원자가 안 붙으면 취소되고 보증금은 돌려받습니다.
        </span>
      </label>

      <div style={styles.notice}>
        <strong>등록하면 보증금 인보이스가 옵니다.</strong> 결제해야 오더북에 올라갑니다.
        거래가 정상적으로 끝나면 돌려받고, <strong>후원자가 붙은 뒤 6시간 안에 펀딩을
        컨펌시키지 못하면 잃습니다.</strong>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      <button type="submit" style={styles.submit} disabled={busy}>
        {busy ? '등록 중…' : '의뢰 등록'}
      </button>
    </form>
  );
}

const styles = {
  form: { display: 'flex', flexDirection: 'column' as const, gap: 14 },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 6, fontSize: 13, fontWeight: 600 as const, color: '#374151' },
  input: { padding: '10px 12px', fontSize: 15, border: '1px solid #D1D5DB', borderRadius: 8 },
  hint: { fontSize: 11, fontWeight: 400 as const, color: '#6B7280', lineHeight: 1.5 },
  notice: { background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#9A3412', lineHeight: 1.6 },
  error: { margin: 0, fontSize: 13, color: '#DC2626' },
  submit: { padding: '12px', fontSize: 15, fontWeight: 600 as const, background: '#2563EB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
};
