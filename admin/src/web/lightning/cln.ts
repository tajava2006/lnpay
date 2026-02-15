import type { LightningAdapter } from './adapter';
import type { NodeInfo } from './types';

/** CLN clnrest POST /v1/getinfo 응답 (사용하는 필드만) */
interface ClnGetInfoResponse {
  id: string;
  alias: string;
  num_active_channels: number;
  num_peers: number;
  blockheight: number;
  version: string;
  warning_bitcoind_sync?: string;
}

/** CLN clnrest POST /v1/listfunds 응답 (사용하는 필드만) */
interface ClnListFundsResponse {
  channels: Array<{ our_amount_msat: number; state: string }>;
  outputs: Array<{ amount_msat: number; status: string }>;
}

async function postJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CLN ${url} 실패: ${res.status} ${text}`);
  }
  return res.json();
}

export class ClnAdapter implements LightningAdapter {
  async getInfo(): Promise<NodeInfo> {
    const [info, funds] = await Promise.all([
      postJson<ClnGetInfoResponse>('/lnapi/v1/getinfo'),
      postJson<ClnListFundsResponse>('/lnapi/v1/listfunds'),
    ]);

    const channelBalanceMsat = funds.channels
      .filter((ch) => ch.state === 'CHANNELD_NORMAL')
      .reduce((sum, ch) => sum + ch.our_amount_msat, 0);

    const onchainBalanceMsat = funds.outputs
      .filter((o) => o.status === 'confirmed')
      .reduce((sum, o) => sum + o.amount_msat, 0);

    return {
      pubkey: info.id,
      alias: info.alias,
      activeChannelsCount: info.num_active_channels,
      peersCount: info.num_peers,
      blockHeight: info.blockheight,
      syncedToChain: !info.warning_bitcoind_sync,
      version: info.version,
      channelBalanceSat: Math.floor(channelBalanceMsat / 1000),
      onchainBalanceSat: Math.floor(onchainBalanceMsat / 1000),
    };
  }
}
