/**
 * 체인 탐색기 링크 — 네트워크마다 경로가 다르다 (2026-09-25 signet 드릴)
 */
import { describe, expect, it } from 'vitest';
import { explorerAddressUrl, explorerTxUrl } from '../onchain';

// BIP-173 예시 주소 (P2WPKH)
const MAIN = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const TEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const TXID = 'ab'.repeat(32);

describe('주소', () => {
  it('mainnet은 접두사가 없고 signet·testnet은 붙는다', () => {
    expect(explorerAddressUrl('mainnet', MAIN)).toBe(`https://mempool.space/address/${MAIN}`);
    expect(explorerAddressUrl('signet', TEST)).toBe(`https://mempool.space/signet/address/${TEST}`);
    expect(explorerAddressUrl('testnet', TEST)).toBe(`https://mempool.space/testnet/address/${TEST}`);
  });

  it('그 네트워크 주소가 아니면 링크가 없다 — 엉뚱한 경로로 "없는 주소"를 보여주지 않는다', () => {
    expect(explorerAddressUrl('signet', MAIN)).toBeNull();
    expect(explorerAddressUrl('mainnet', TEST)).toBeNull();
    expect(explorerAddressUrl('mainnet', undefined)).toBeNull();
  });

  it('regtest는 공개 탐색기가 없다', () => {
    expect(explorerAddressUrl('regtest', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')).toBeNull();
  });
});

describe('tx', () => {
  it('txid와 아웃포인트(txid:vout) 둘 다 받는다', () => {
    expect(explorerTxUrl('mainnet', TXID)).toBe(`https://mempool.space/tx/${TXID}`);
    expect(explorerTxUrl('signet', `${TXID}:1`)).toBe(`https://mempool.space/signet/tx/${TXID}`);
  });

  it('txid 모양이 아니면 링크가 없다', () => {
    expect(explorerTxUrl('mainnet', 'nope')).toBeNull();
    expect(explorerTxUrl('mainnet', undefined)).toBeNull();
    expect(explorerTxUrl('regtest', TXID)).toBeNull();
  });
});
