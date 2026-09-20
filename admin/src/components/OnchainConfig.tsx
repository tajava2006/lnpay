/**
 * 온체인 트랙 스위치 (PLAN-ONCHAIN-TRACK §1.2 · §11 P6)
 *
 * **기본이 꺼짐**이고, 켜는 건 명시적 행동이다. 라이트닝 트랙을 안 건드리고
 * 붙였다 뗐다 할 수 있어야 한다.
 *
 * ⚠️ 진행 중인 온체인 주문이 있으면 **네트워크를 못 바꾸게** 막는다 —
 * 바꾸는 순간 이미 발행된 에스크로 주소가 다른 체인의 것이 되고, 거기 있는
 * 자금은 아무도 못 만진다.
 */
import { useState, useSyncExternalStore } from 'react';
import type { ChainNetwork } from '@sajwo-tracker/shared/onchain';
import {
  getOnchainBaseUrl, getOnchainNetwork, isOnchainEnabled,
  setOnchainBaseUrl, setOnchainEnabled, setOnchainNetwork,
} from '../onchain/config';
import { getSnapshot, subscribe } from '../onchain/order-store';

const NETWORKS: ChainNetwork[] = ['signet', 'testnet', 'mainnet'];

export function OnchainConfig({ onChanged }: { onChanged: () => void }) {
  const orders = useSyncExternalStore(subscribe, getSnapshot);
  const [enabled, setEnabled] = useState(isOnchainEnabled);
  const [network, setNetwork] = useState<ChainNetwork>(getOnchainNetwork);
  const [baseUrl, setBaseUrl] = useState(getOnchainBaseUrl() ?? '');

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

const styles = {
  box: { display: 'flex', flexDirection: 'column' as const, gap: 8, padding: '10px 12px', border: '1px solid #E5E7EB', borderRadius: 8 },
  row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151' },
  hint: { fontSize: 12, color: '#6B7280' },
  lock: { fontSize: 11, color: '#B45309' },
  select: { padding: '4px 8px', fontSize: 13, borderRadius: 6, border: '1px solid #D1D5DB' },
  input: { flex: 1, padding: '5px 9px', fontSize: 13, borderRadius: 6, border: '1px solid #D1D5DB' },
};
