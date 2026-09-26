import { useEffect, useState } from 'react';
import { BUTTON } from '@sajwo-tracker/shared';
import type { OnchainOrder } from '@sajwo-tracker/shared/onchain';
import { clearSignRequest, type SignRequest } from '../sign-request-store';
import { getRefundAddress } from '../refund-address-store';
import { getMyClaim } from '../claim-store';
import { buildCosignature } from '../actions';
import { checkSignRequest, releaseNeedsPriceOverride, type SignCheck } from '../verify';
import { myOrderXonly } from '../keys';
import { publishOnchainCosign } from '../nostr/publish';
import { styles } from './card-styles';

/**
 * 서명 요청 — 릴리스·환불·분쟁·구조 공용. **내 기록으로 다시 만든 tx에만 서명한다.**
 *
 * 릴리스(원화 입금 확인)는 **버튼 하나**로 보인다(2026-09-25 드릴). 파는 사람이 알아야 할 건 "원화가
 * 들어왔는가" 하나다 — 금액·받는 주소·수수료·"내 기록과 같다"는 그 판단에 쓸모가 없다. 대조는 그대로
 * 돈다: 맞지 않으면 버튼 대신 경고가 뜬다. 되돌릴 수 없으니 누르기 전에 한 번 묻는다.
 *
 * 받는 주소가 내가 기대한 곳(환불이면 내가 낸 환불 주소, 후원자승이면 내가 낸 받을
 * 주소)이 아니면 버튼이 안 열린다. 이 기기가 환불 주소를 모르면(다른 기기에서 키를
 * 가져온 경우) **유저가 다시 입력**하게 해서 대조한다 — 보여주고 "맞다"를 누르게 하면
 * 대조가 아니다.
 */
export function SignPanel({ order, role, request }: {
  order: OnchainOrder;
  role: 'customer' | 'sponsor';
  request: SignRequest;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<SignCheck | null>(null);
  const [typedRefund, setTypedRefund] = useState('');
  const [override, setOverride] = useState(false);
  const stale = request.purpose === 'release' && releaseNeedsPriceOverride(order, Date.now());

  useEffect(() => {
    let alive = true;
    void (async () => {
      const myXonly = await myOrderXonly(order.orderId);
      const result = checkSignRequest({
        order,
        purpose: request.purpose,
        psbt: request.psbt,
        role,
        myXonly,
        refundAddress: getRefundAddress(order.orderId) ?? (typedRefund.trim() || undefined),
        payoutAddress: getMyClaim(order.orderId)?.payoutAddress,
      });
      if (alive) setCheck(result);
    })();
    return () => { alive = false; };
  }, [order, request, role, typedRefund]);

  const isRelease = request.purpose === 'release';
  const title = isRelease ? '원화 입금 확인'
    : request.purpose === 'refund' ? '환불 서명 (에스크로 회수)'
    : request.purpose === 'rescue' ? '구조 서명 (약정 밖의 자금 돌려받기)'
    : '분쟁 판정 집행 서명';

  async function sign() {
    if (!check?.ok) return;
    if (isRelease && !confirm('은행에 원화가 실제로 들어왔나요?\n\n확인하면 비트코인이 상대방에게 넘어가고, 되돌릴 수 없습니다.')) return;
    setBusy(true);
    setError(null);
    try {
      const signed = await buildCosignature(order.orderId, check);
      if (!signed.ok) return setError(signed.reason);
      const result = await publishOnchainCosign(order.orderId, request.purpose, signed.psbt);
      if (!result.success) return setError('발행에 실패했습니다. 다시 시도하세요.');
      clearSignRequest(request);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.section}>
      <p style={styles.sectionTitle}>{title}</p>

      {!check ? (
        <p style={styles.warnText}>확인하는 중…</p>
      ) : !check.ok ? (
        <>
          <p style={styles.dangerText}>⚠️ {check.reason} — {isRelease ? '진행하지 말고 운영자에게 알리세요' : '서명하지 마세요'}.</p>
          {check.needsRefundAddress && (
            <input
              style={styles.input}
              placeholder="의뢰 때 낸 환불 주소를 입력하세요"
              value={typedRefund}
              onChange={e => setTypedRefund(e.target.value)}
            />
          )}
        </>
      ) : (
        <>
          {isRelease ? (
            <p style={styles.warnText}>
              <strong>은행에 원화가 실제로 들어왔는지 먼저 확인하세요.</strong> 누르면 비트코인이 상대방에게 넘어갑니다.
            </p>
          ) : (
            <>
              <p style={styles.okText}>
                <strong>{check.amountSat.toLocaleString()} sats</strong>가 아래 주소로 갑니다
                (네트워크 수수료 {check.feeSat.toLocaleString()} sats).
              </p>
              <code style={styles.addr}>{check.destination}</code>
            </>
          )}

          {stale && (
            <div style={styles.danger}>
              <strong>가격 유효창이 지났습니다.</strong>
              <p style={styles.dangerText}>
                이 금액은 24시간 넘게 전의 시세입니다. 지금 시세와 다를 수 있습니다.
              </p>
              <label style={styles.checkbox}>
                <input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} />
                알고도 진행합니다
              </label>
            </div>
          )}

          {error && <p style={styles.dangerText}>{error}</p>}

          <button
            style={stale && !override ? styles.disabled : styles.primary}
            disabled={busy || (stale && !override)}
            onClick={() => void sign()}
          >
            {busy ? '보내는 중…' : isRelease ? BUTTON.confirmReleased : '서명하고 보내기'}
          </button>
        </>
      )}
    </div>
  );
}
