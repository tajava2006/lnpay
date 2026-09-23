/**
 * 온체인 트랙 스위치 (PLAN-ONCHAIN-TRACK §1.2 · §11 P6)
 *
 * **기본이 꺼짐**이고, 켜는 건 명시적 행동이다. 라이트닝 트랙을 안 건드리고
 * 붙였다 뗐다 할 수 있어야 한다.
 *
 * ⚠️ 진행 중인 온체인 주문이 있으면 **네트워크를 못 바꾸게** 막는다 —
 * 바꾸는 순간 이미 발행된 에스크로 주소가 다른 체인의 것이 되고, 거기 있는
 * 자금은 아무도 못 만진다.
 *
 * ── 워처 소유권 (§9.1)
 *
 * 자동 집행은 **한 번에 한 기기**만 한다. 여기가 그걸 보여주고 옮기는 자리다.
 * 옮기지 않은 기기도 조회와 분쟁 판정은 그대로 된다 — 막는 건 자동 경로뿐이다.
 */
import { useState, useSyncExternalStore } from 'react';
import type { ChainNetwork } from '@sajwo-tracker/shared/onchain';
import {
  getOnchainBaseUrl, getOnchainNetwork, getOnchainOperatorPubkey, isOnchainEnabled,
  setOnchainBaseUrl, setOnchainEnabled, setOnchainNetwork, setOnchainOperatorPubkey,
} from '../onchain/config';
import { getSnapshot, subscribe } from '../onchain/order-store';
import {
  claimWatcherLease, getLeaseSnapshot, leaseBlockText, subscribeLease,
} from '../onchain/lease';

const NETWORKS: ChainNetwork[] = ['signet', 'testnet', 'mainnet'];

export function OnchainConfig({ onChanged }: { onChanged: () => void }) {
  const orders = useSyncExternalStore(subscribe, getSnapshot);
  const lease = useSyncExternalStore(subscribeLease, getLeaseSnapshot);
  const [enabled, setEnabled] = useState(isOnchainEnabled);
  const [network, setNetwork] = useState<ChainNetwork>(getOnchainNetwork);
  const [baseUrl, setBaseUrl] = useState(getOnchainBaseUrl() ?? '');
  const [operator, setOperator] = useState(getOnchainOperatorPubkey() ?? '');
  const [notifyPerm, setNotifyPerm] = useState(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  const live = Object.values(orders).filter(o => o.status === 'active').length;
  const locked = live > 0;

  return (
    <div style={styles.box}>
      <label style={styles.row}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => {
            setOnchainEnabled(e.target.checked);
            setEnabled(e.target.checked);
            onChanged();
          }}
        />
        <strong>온체인 트랙</strong>
        <span style={styles.hint}>
          {enabled ? '켜짐 — 구독과 워처가 돈다' : '꺼짐 — 라이트닝만 돈다'}
        </span>
      </label>

      <label style={styles.row}>
        네트워크
        <select
          value={network}
          disabled={locked}
          onChange={e => {
            const next = e.target.value as ChainNetwork;
            setOnchainNetwork(next);
            setNetwork(next);
            onChanged();
          }}
          style={styles.select}
        >
          {NETWORKS.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        {locked && (
          <span style={styles.lock}>
            진행 중 {live}건 — 바꾸면 그 주소가 다른 체인 것이 된다
          </span>
        )}
      </label>

      {enabled && (
        <div style={styles.row}>
          <span style={lease.acting ? styles.ok : styles.lock}>
            {lease.acting ? '●' : '○'} 워처
          </span>
          <span style={styles.hint}>{leaseBlockText(lease)}</span>
          {!lease.acting && lease.why !== 'handover-wait' && (
            <TakeoverButton />
          )}
        </div>
      )}

      {/*
        운영자 호출 (리뷰 #8) — 분쟁 진입·경보를 운영자의 nostr 클라이언트로 보낸다.
        §7.3 ③("침묵 공격은 어드민이 와야만 깨진다")이 실제로 작동하려면 여기가 채워져 있어야 한다.
      */}
      <label style={styles.row}>
        운영자 알림
        <input
          style={styles.input}
          value={operator}
          placeholder="운영자 nostr pubkey (hex) — 분쟁·경보를 DM으로"
          onChange={e => setOperator(e.target.value)}
          onBlur={() => setOnchainOperatorPubkey(operator)}
        />
        {notifyPerm === 'default' && (
          <button
            style={styles.takeover}
            onClick={() => void Notification.requestPermission().then(setNotifyPerm)}
          >
            브라우저 알림 허용
          </button>
        )}
      </label>

      <label style={styles.row}>
        mempool API
        <input
          style={styles.input}
          value={baseUrl}
          placeholder="비우면 공개 mempool.space"
          onChange={e => setBaseUrl(e.target.value)}
          onBlur={() => { setOnchainBaseUrl(baseUrl.trim()); onChanged(); }}
        />
      </label>
    </div>
  );
}

/**
 * 소유권을 이 기기로 가져온다.
 *
 * ⚠️ **옛 주인이 알아채는 데 한 틱(30초)이 걸린다.** 그래서 가져온 직후 바로
 * 돌지 않고 인수 지연이 지난 뒤에 시작한다 — 그 사이 둘 다 도는 걸 막는 게
 * 이 기능의 전부다.
 */
function TakeoverButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        style={styles.takeover}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          claimWatcherLease()
            .catch((e: unknown) => setError(e instanceof Error ? e.message : '실패'))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? '가져오는 중…' : '이 기기로 가져오기'}
      </button>
      {error && <span style={styles.lock}>{error}</span>}
    </>
  );
}

const styles = {
  box: { display: 'flex', flexDirection: 'column' as const, gap: 8, padding: '10px 12px', border: '1px solid #E5E7EB', borderRadius: 8 },
  row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151' },
  hint: { fontSize: 12, color: '#6B7280' },
  lock: { fontSize: 11, color: '#B45309' },
  ok: { fontSize: 12, color: '#047857' },
  takeover: { padding: '3px 9px', fontSize: 12, borderRadius: 6, border: '1px solid #D1D5DB', background: '#fff', cursor: 'pointer' },
  select: { padding: '4px 8px', fontSize: 13, borderRadius: 6, border: '1px solid #D1D5DB' },
  input: { flex: 1, padding: '5px 9px', fontSize: 13, borderRadius: 6, border: '1px solid #D1D5DB' },
};
