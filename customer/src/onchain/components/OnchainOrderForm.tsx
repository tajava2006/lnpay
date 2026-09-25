/**
 * 온체인 의뢰 등록 (고객)
 *
 * 라이트닝과 다른 점: **수량(sats)을 정한다.** 가격은 여기서 안 정한다 —
 * 펀딩이 컨펌되는 시점의 시세로 정해진다. 그래야 아무도 공짜 옵션을
 * 쥐지 않는다.
 *
 * 대신 **최저가(reserve)** 로 아래쪽을 막는다. 한 달 방치된 시장가 주문은
 * 플래시 크래시에 그대로 노출되기 때문이다. 다만 시세 바로 아래에 걸면 컨펌을
 * 기다리는 동안의 공짜 옵션이 되므로 **시세보다 3% 이상 낮아야** 한다.
 *
 * **환불 받을 주소**를 여기서 받는다. 환불은 고객이 응답하지 않을 때도
 * 나가므로 미리 받아둬야 하는데, 전에는 이 앱만 쓸 수 있는 주소로 보냈고 꺼낼
 * 화면이 없었다.
 */
import { useState, useSyncExternalStore } from 'react';
import { freshPrice, type PriceTracker } from '@sajwo-tracker/shared';
import {
  FUNDING_WINDOW_SEC, MAX_ORDER_EXPIRY_SEC, RESERVE_MIN_GAP_PERCENT, addressProblem, durationText, reserveProblem,
} from '@sajwo-tracker/shared/onchain';
import { myOrderXonly } from '../keys';
import { publishOnchainOrderRequest } from '../nostr/publish';
import { rememberPendingRequest } from '../pending-request-store';
import { rememberRefundAddress } from '../refund-address-store';

const DAY = 86_400;

function newOrderId(): string {
  return `oc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const NO_SUBSCRIBE = () => () => {};
const NO_SNAPSHOT = () => null;

/** 받는 주소가 어느 네트워크 것이든 비트코인 주소인지 (어드민이 네트워크를 다시 본다) */
function refundAddressProblem(address: string): string | null {
  if (!address.trim()) return '환불 받을 주소를 입력하세요.';
  const ok = (['mainnet', 'signet', 'regtest'] as const).some(n => addressProblem(address, n) === null);
  return ok ? null : '비트코인 주소가 아닙니다.';
}

export function OnchainOrderForm({ onDone, tracker }: {
  onDone?: () => void;
  tracker?: PriceTracker;
}) {
  const priceSnapshot = useSyncExternalStore(
    tracker?.subscribe ?? NO_SUBSCRIBE,
    tracker?.getSnapshot ?? NO_SNAPSHOT,
  );
  const [amountSat, setAmountSat] = useState('');
  const [reserveKrw, setReserveKrw] = useState('');
  const [refundAddress, setRefundAddress] = useState('');
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
    if (reserve !== undefined) {
      const price = priceSnapshot ? freshPrice(priceSnapshot, Date.now(), 60_000, 1) ?? undefined : undefined;
      const problem = reserveProblem({ reserveKrw: reserve, amountSat: sats, btcPriceKrw: price });
      if (problem) return setError(problem);
    }
    const addrProblem = refundAddressProblem(refundAddress);
    if (addrProblem) return setError(addrProblem);

    setBusy(true);
    try {
      const orderId = newOrderId();
      const customerXonly = await myOrderXonly(orderId);
      const expiration = Math.floor(Date.now() / 1000) + days * DAY;
      const result = await publishOnchainOrderRequest({
        orderId, amountSat: sats, reserveKrw: reserve, customerXonly, expiration,
        refundAddress: refundAddress.trim(),
      });
      if (!result.success) {
        setError('발행에 실패했습니다. 잠시 후 다시 시도하세요.');
        return;
      }
      // 환불 PSBT에 서명하기 전에 **받는 주소가 이것인지** 대조하는 데 쓴다.
      rememberRefundAddress(orderId, refundAddress.trim());
      // ⚠️ **보낸 요청을 적어둔다.** 오더는 보증금을 결제해야 생기므로, 그 전에
      // 어드민이 거절하거나 실패하면 유저 쪽에 흔적이 하나도 안 남는다.
      rememberPendingRequest({
        orderId, amountSat: sats, reserveKrw: reserve, expiration,
        submittedAt: Math.floor(Date.now() / 1000),
      });
      setAmountSat('');
      setReserveKrw('');
      setRefundAddress('');
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
          지금 시세보다 {RESERVE_MIN_GAP_PERCENT}% 이상 낮게만 걸 수 있습니다.
        </span>
      </label>

      <label style={styles.label}>
        환불 받을 주소
        <input
          style={styles.input}
          value={refundAddress}
          onChange={e => setRefundAddress(e.target.value)}
          placeholder="bc1… (내 지갑 주소)"
        />
        <span style={styles.hint}>
          거래가 성사되지 않으면 에스크로가 이 주소로 돌아옵니다. 운영자에게만 암호화되어 전달됩니다.
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
          최대 {MAX_ORDER_EXPIRY_SEC / DAY}일. 그 안에 사는 사람이 안 붙으면 취소되고 보증금은 돌려받습니다.
        </span>
      </label>

      <div style={styles.notice}>
        <strong>등록하면 보증금 인보이스가 옵니다.</strong> 결제해야 오더북에 올라갑니다.
        거래가 정상적으로 끝나면 돌려받고, <strong>사는 사람이 붙은 뒤 {durationText(FUNDING_WINDOW_SEC)} 안에
        입금을 컨펌시키지 못하면 몰수됩니다.</strong>
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
