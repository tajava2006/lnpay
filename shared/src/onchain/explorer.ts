/**
 * 체인 탐색기 링크 (mempool.space 웹)
 *
 * 온체인은 기다리는 구간이 길다 — 입금 컨펌, 종결 tx 컨펌. 앱이 "기다리는 중"만 말하면 답답하고,
 * RBF·CPFP로 수수료를 올리려면 멤풀에서 내 tx가 어디쯤인지 눈으로 봐야 한다(2026-09-25 signet 드릴).
 *
 * ⚠️ **네트워크마다 경로가 다르다** — mainnet은 접두사가 없고 signet·testnet은 붙는다. 주소를 엉뚱한
 * 네트워크 경로로 걸면 "없는 주소"가 떠서 더 헷갈린다. 그래서 주소는 **그 네트워크 것인지 확인한 뒤에만**
 * 링크를 만들고, regtest(공개 탐색기가 없다)나 모르는 값이면 링크를 안 만든다.
 *
 * API 주소(`DEFAULT_MEMPOOL_API`)와는 따로다 — 데몬은 자체 인스턴스를 쓸 수 있지만, 사람이 눈으로 보는
 * 건 공개 mempool.space면 된다.
 */
import { addressProblem, type BtcNetworkName } from './address';

const EXPLORER_BASE: Partial<Record<BtcNetworkName, string>> = {
  mainnet: 'https://mempool.space',
  signet: 'https://mempool.space/signet',
  testnet: 'https://mempool.space/testnet',
};

const TXID = /^[0-9a-f]{64}$/;

/** 주소 페이지 — 들어오는 멤풀 tx까지 보인다. 그 네트워크 주소가 아니면 null */
export function explorerAddressUrl(network: BtcNetworkName, address: string | undefined): string | null {
  const base = EXPLORER_BASE[network];
  if (!base || !address || addressProblem(address, network) !== null) return null;
  return `${base}/address/${address}`;
}

/** tx 페이지. `txid:vout`(아웃포인트)도 받는다 */
export function explorerTxUrl(network: BtcNetworkName, txidOrOutpoint: string | undefined): string | null {
  const base = EXPLORER_BASE[network];
  const txid = txidOrOutpoint?.split(':')[0]?.toLowerCase();
  if (!base || !txid || !TXID.test(txid)) return null;
  return `${base}/tx/${txid}`;
}
