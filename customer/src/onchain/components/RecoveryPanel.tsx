/**
 * 비상 회수 · 환불금 꺼내기 (고객)
 *
 * 스크립트에 길이 있어도 **앱에 버튼이 없으면 유저는 못 쓴다**(TODO — 리뷰 #8에서 닫음).
 * 두 가지를 여기서 한다:
 *
 * ① **타임락 회수** — 운영자가 사라졌을 때 에스크로를 혼자 빼는 4번 리프. CSV가 차야
 *    쓸 수 있다(펀딩 컨펌부터 8064블록). 약정 밖으로 들어온 자금(늦은 펀딩·금액이 틀린
 *    펀딩)도 운영자가 응답하지 않으면 이 길로 나간다.
 * ② **옛 환불 주소에서 꺼내기** — 환불 주소를 받기 전에 만든 주문은 환불이 주문별
 *    키 주소로 왔다. 이 앱만 쓸 수 있는 주소라 꺼내는 화면이 없으면 갇혀 있다.
 *    멤풀에 있는 환불 출력도 쓰므로, 막힌 환불 tx를 **CPFP로 끌어올리는** 데도 쓴다.
 *
 * 체인 조회는 헌법의 예외가 아니다 — 릴레이가 아니라 체인이고, 유저가 열었을 때만
 * 한 번 묻는다(원화 송금 화면의 타임락 확인과 같은 자리).
 */
import { useEffect, useState } from 'react';
import {
  MempoolChainAdapter, deriveSingleKeyAddress,
  type ChainUtxo, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { myOrderXonly } from '../keys';
import { buildRefundSweep, buildTimelockSweep } from '../actions';

function chainFor(order: OnchainOrder): MempoolChainAdapter {
  return new MempoolChainAdapter({
    network: order.network === 'mainnet' ? 'mainnet' : order.network === 'testnet' ? 'testnet' : 'signet',
  });
}

interface Loaded {
  escrow: ChainUtxo[];
  legacy: { address: string; utxos: ChainUtxo[] };
  halfHour?: number;
}

export function RecoveryPanel({ order }: { order: OnchainOrder }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !order.escrowAddress) return;
    let alive = true;
    void (async () => {
      const chain = chainFor(order);
      const legacyAddress = deriveSingleKeyAddress(await myOrderXonly(order.orderId), order.network);
      const [escrow, legacy, fees] = await Promise.all([
        chain.getAddressFunds(order.escrowAddress!),
        chain.getAddressFunds(legacyAddress),
        chain.getFeeEstimates(),
      ]);
      if (!alive) return;
      if (!escrow.known || !legacy.known) {
        setError(`체인을 조회하지 못했습니다: ${!escrow.known ? escrow.reason : !legacy.known ? legacy.reason : ''}`);
        return;
      }
      setData({
        escrow: escrow.value.confirmed,
        legacy: { address: legacyAddress, utxos: [...legacy.value.confirmed, ...legacy.value.mempool] },
        halfHour: fees.known ? fees.value.halfHour : undefined,
      });
    })();
    return () => { alive = false; };
  }, [open, order]);

  if (!order.escrowAddress) return null;
  if (!open) {
    return (
      <button style={styles.toggle} onClick={() => setOpen(true)}>
        비상 회수 · 환불금 꺼내기
      </button>
    );
  }

  return (
    <div style={styles.box}>
      <p style={styles.title}>비상 회수 · 환불금 꺼내기</p>
      {error && <p style={styles.error}>{error}</p>}
      {!data && !error && <p style={styles.note}>체인을 확인하는 중…</p>}
      {data && (
        <>
          {data.legacy.utxos.length > 0 && (
            <LegacySweep order={order} utxos={data.legacy.utxos} feerate={data.halfHour} />
          )}
          <TimelockList order={order} utxos={data.escrow} feerate={data.halfHour} />
          {data.legacy.utxos.length === 0 && data.escrow.length === 0 && (
            <p style={styles.note}>에스크로 주소와 옛 환불 주소 모두 비어 있습니다. 꺼낼 자금이 없습니다.</p>
          )}
        </>
      )}
      <button style={styles.toggle} onClick={() => setOpen(false)}>닫기</button>
    </div>
  );
}

function LegacySweep({ order, utxos, feerate }: {
  order: OnchainOrder; utxos: ChainUtxo[]; feerate?: number;
}) {
  const total = utxos.reduce((n, u) => n + u.valueSat, 0);
  return (
    <div style={styles.section}>
      <p style={styles.sub}>옛 환불 주소의 자금 — {total.toLocaleString()} sats</p>
      <p style={styles.note}>
        이 주문의 환불이 이 앱만 쓸 수 있는 주소로 왔습니다. 내 지갑으로 보내세요.
        아직 컨펌되지 않은 환불이면 수수료를 높여 보내 <strong>함께 컨펌되게</strong>(CPFP) 할 수 있습니다.
      </p>
      <SendForm
        defaultFeerate={feerate}
        label="내 지갑으로 보내기"
        onSend={async (dest, rate) => {
          const built = await buildRefundSweep(order, utxos, dest, rate);
          if (!built.ok) return built.reason;
          const sent = await chainFor(order).broadcastTx(built.hex);
          return sent.known ? `보냈습니다: ${sent.value}` : `브로드캐스트 실패: ${sent.reason}`;
        }}
      />
    </div>
  );
}

function TimelockList({ order, utxos, feerate }: {
  order: OnchainOrder; utxos: ChainUtxo[]; feerate?: number;
}) {
  const csv = order.timelockBlocks ?? 0;
  if (utxos.length === 0) return null;
  return (
    <div style={styles.section}>
      <p style={styles.sub}>타임락 회수 — 운영자가 응답하지 않을 때</p>
      <p style={styles.note}>
        정상 거래·환불은 이 길을 쓰지 않습니다. 운영자가 사라졌을 때만 씁니다 — 각 UTXO가
        컨펌된 지 {csv.toLocaleString()}블록(약 {Math.round(csv / 144)}일)이 지나야 혼자 뺄 수 있습니다.
      </p>
      {utxos.map(u => {
        const left = csv - u.confirmations;
        return (
          <div key={`${u.txid}:${u.vout}`} style={styles.utxo}>
            <span>{u.valueSat.toLocaleString()} sats · {u.confirmations.toLocaleString()} 컨펌</span>
            {left > 0 ? (
              <span style={styles.note}>{left.toLocaleString()}블록(약 {Math.ceil(left / 144)}일) 남음</span>
            ) : (
              <SendForm
                defaultFeerate={feerate}
                label="혼자 회수하기"
                onSend={async (dest, rate) => {
                  const built = await buildTimelockSweep(order, u, dest, rate);
                  if (!built.ok) return built.reason;
                  const sent = await chainFor(order).broadcastTx(built.hex);
                  return sent.known ? `보냈습니다: ${sent.value}` : `브로드캐스트 실패: ${sent.reason}`;
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SendForm({ defaultFeerate, label, onSend }: {
  defaultFeerate?: number;
  label: string;
  onSend: (destination: string, feerate: number) => Promise<string>;
}) {
  const [dest, setDest] = useState('');
  const [rate, setRate] = useState(defaultFeerate ? String(defaultFeerate) : '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <div style={styles.form}>
      <input style={styles.input} placeholder="받을 내 지갑 주소" value={dest} onChange={e => setDest(e.target.value)} />
      <input
        style={styles.input}
        placeholder="수수료율 (sat/vB)"
        inputMode="decimal"
        value={rate}
        onChange={e => setRate(e.target.value.replace(/[^0-9.]/g, ''))}
      />
      <button
        style={styles.btn}
        disabled={busy || !dest.trim() || !(Number(rate) > 0)}
        onClick={() => {
          if (!confirm(`${dest.trim()} 로 보냅니다. 되돌릴 수 없습니다.`)) return;
          setBusy(true);
          void onSend(dest.trim(), Number(rate)).then(setResult).finally(() => setBusy(false));
        }}
      >
        {busy ? '보내는 중…' : label}
      </button>
      {result && <p style={styles.note}>{result}</p>}
    </div>
  );
}

const styles = {
  toggle: { padding: '8px', fontSize: 12, background: '#fff', color: '#6B7280', border: '1px dashed #D1D5DB', borderRadius: 8, cursor: 'pointer' },
  box: { display: 'flex', flexDirection: 'column' as const, gap: 10, border: '1px solid #E5E7EB', borderRadius: 10, padding: 12 },
  title: { margin: 0, fontSize: 13, fontWeight: 600 as const, color: '#374151' },
  sub: { margin: 0, fontSize: 12, fontWeight: 600 as const, color: '#374151' },
  section: { display: 'flex', flexDirection: 'column' as const, gap: 6, borderTop: '1px solid #F3F4F6', paddingTop: 8 },
  utxo: { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 12, color: '#374151' },
  form: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  input: { padding: '8px 10px', fontSize: 13, border: '1px solid #D1D5DB', borderRadius: 8 },
  btn: { padding: '8px', fontSize: 13, fontWeight: 600 as const, background: '#374151', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  note: { margin: 0, fontSize: 12, color: '#6B7280', lineHeight: 1.6 },
  error: { margin: 0, fontSize: 12, color: '#DC2626' },
};
