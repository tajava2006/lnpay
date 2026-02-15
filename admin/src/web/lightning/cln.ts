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

export class ClnAdapter implements LightningAdapter {
  async getInfo(): Promise<NodeInfo> {
    const res = await fetch('/lnapi/v1/getinfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`CLN getinfo 실패: ${res.status} ${text}`);
    }

    const data: ClnGetInfoResponse = await res.json();

    return {
      pubkey: data.id,
      alias: data.alias,
      activeChannelsCount: data.num_active_channels,
      peersCount: data.num_peers,
      blockHeight: data.blockheight,
      syncedToChain: !data.warning_bitcoind_sync,
      version: data.version,
    };
  }
}
