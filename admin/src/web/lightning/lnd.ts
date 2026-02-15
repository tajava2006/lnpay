import type { LightningAdapter } from './adapter';
import type { NodeInfo } from './types';

/** LND REST /v1/getinfo 응답 (사용하는 필드만) */
interface LndGetInfoResponse {
  identity_pubkey: string;
  alias: string;
  num_active_channels: number;
  num_peers: number;
  block_height: number;
  synced_to_chain: boolean;
  version: string;
}

export class LndAdapter implements LightningAdapter {
  async getInfo(): Promise<NodeInfo> {
    const res = await fetch('/lnapi/v1/getinfo');

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LND getinfo 실패: ${res.status} ${text}`);
    }

    const data: LndGetInfoResponse = await res.json();

    return {
      pubkey: data.identity_pubkey,
      alias: data.alias,
      activeChannelsCount: data.num_active_channels,
      peersCount: data.num_peers,
      blockHeight: data.block_height,
      syncedToChain: data.synced_to_chain,
      version: data.version,
    };
  }
}
