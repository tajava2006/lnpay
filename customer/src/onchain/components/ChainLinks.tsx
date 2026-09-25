/**
 * 체인에서 보기 — 에스크로 주소 · 입금 tx · 종결 tx를 mempool.space로 (2026-09-25 signet 드릴)
 *
 * 컨펌을 기다리는 동안 앱은 "기다리는 중"밖에 말할 게 없다. 멤풀에서 내 tx가 어디쯤인지 보여야 덜 답답하고,
 * RBF·CPFP로 수수료를 올릴지도 거기서 판단한다. 두 역할 다 본다.
 *
 * 링크는 오더의 네트워크를 따른다(signet이면 /signet). 그 네트워크 주소가 아니면 링크를 안 만든다 —
 * `explorer.ts`.
 */
import { explorerAddressUrl, explorerTxUrl, type OnchainOrder } from '@sajwo-tracker/shared/onchain';

export function ChainLinks({ order }: { order: OnchainOrder }) {
  const links = [
    { label: '에스크로 주소', href: explorerAddressUrl(order.network, order.escrowAddress) },
    { label: '입금 tx', href: explorerTxUrl(order.network, order.fundingOutpoint) },
    { label: '종결 tx', href: explorerTxUrl(order.network, order.settlementTxid) },
  ].filter((l): l is { label: string; href: string } => l.href !== null);
  if (links.length === 0) return null;

  return (
    <p style={styles.row}>
      <span style={styles.caption}>체인에서 보기{order.network !== 'mainnet' ? ` (${order.network})` : ''}</span>
      {links.map(l => (
        <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" style={styles.link}>
          {l.label} ↗
        </a>
      ))}
    </p>
  );
}

const styles = {
  row: { margin: 0, display: 'flex', flexWrap: 'wrap' as const, alignItems: 'baseline', gap: 10, fontSize: 12 },
  caption: { color: '#6B7280' },
  link: { color: '#2563EB', textDecoration: 'none', fontWeight: 600 as const },
};
