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

/** LND REST /v1/balance/channels 응답 */
interface LndChannelBalanceResponse {
  balance: string;
}

/** LND REST /v1/balance/blockchain 응답 */
interface LndWalletBalanceResponse {
  confirmed_balance: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LND ${url} 실패: ${res.status} ${text}`);
  }
  return res.json();
}

export class LndAdapter implements LightningAdapter {
  async getInfo(): Promise<NodeInfo> {
    const [info, chanBal, walletBal] = await Promise.all([
      fetchJson<LndGetInfoResponse>('/lnapi/v1/getinfo'),
      fetchJson<LndChannelBalanceResponse>('/lnapi/v1/balance/channels'),
      fetchJson<LndWalletBalanceResponse>('/lnapi/v1/balance/blockchain'),
    ]);

    return {
      pubkey: info.identity_pubkey,
      alias: info.alias,
      activeChannelsCount: info.num_active_channels,
      peersCount: info.num_peers,
      blockHeight: info.block_height,
      syncedToChain: info.synced_to_chain,
      version: info.version,
      channelBalanceSat: Number(chanBal.balance || '0'),
      onchainBalanceSat: Number(walletBal.confirmed_balance || '0'),
    };
  }
}
