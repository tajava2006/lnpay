/**
 * 장부 하나 = 모드 하나 · 온체인 네트워크 하나 — 어긋나면 안 뜬다 (2026-09-24)
 *
 * signet 드릴 데몬(`LNPAY_MODE=dev`)을 운영 장부로 띄우거나, 진행 중 오더가 있는 채로 운영 데몬의
 * 네트워크를 바꾸는 실수를 부팅에서 막는다.
 */
import { describe, expect, it } from 'vitest';
import { Db } from '../db';
import { assertDataDirFits } from '../guards';
import { createHarness } from './fakes';

function ocRow(db: Db, orderId: string, state: string, network: string): void {
  db.run('INSERT INTO oc_orders (order_id, state, data) VALUES (?, ?, ?)', orderId, state, JSON.stringify({ orderId, state, network }));
}

describe('모드', () => {
  it('첫 부팅 때 박고, 같은 모드면 계속 뜬다', () => {
    const db = new Db(':memory:');
    assertDataDirFits(db, { mode: 'prod', onchainNetwork: undefined });
    expect(() => assertDataDirFits(db, { mode: 'prod', onchainNetwork: undefined })).not.toThrow();
  });

  it('다른 모드로는 안 뜬다 — signet 드릴 데몬은 자기 장부를 써야 한다', () => {
    const db = new Db(':memory:');
    assertDataDirFits(db, { mode: 'prod', onchainNetwork: undefined });
    expect(() => assertDataDirFits(db, { mode: 'dev', onchainNetwork: 'signet' })).toThrow(/LNPAY_MODE=prod/);
  });

  it('데몬 생성자가 부른다', () => {
    const db = new Db(':memory:');
    db.kvSet('daemon.mode', 'prod');
    expect(() => createHarness().start(db)).toThrow(/다른 데이터 디렉터리/); // 하네스는 dev
  });
});

describe('온체인 네트워크', () => {
  it('진행 중 오더가 다른 네트워크면 안 뜬다', () => {
    const db = new Db(':memory:');
    ocRow(db, 'a', 'funded', 'signet');
    expect(() => assertDataDirFits(db, { mode: 'dev', onchainNetwork: 'mainnet' })).toThrow(/1건이 signet/);
    expect(() => assertDataDirFits(db, { mode: 'dev', onchainNetwork: 'signet' })).not.toThrow();
  });

  it('진행 중 오더가 남았는데 온체인을 끄면 안 뜬다 — 감시가 안 돈다', () => {
    const db = new Db(':memory:');
    ocRow(db, 'a', 'listed', 'mainnet');
    expect(() => assertDataDirFits(db, { mode: 'prod', onchainNetwork: undefined })).toThrow(/온체인을 껐는데/);
  });

  it('끝난 오더는 상관없다 — 네트워크를 바꿔도 된다', () => {
    const db = new Db(':memory:');
    ocRow(db, 'a', 'released', 'signet');
    ocRow(db, 'b', 'cancelled', 'signet');
    expect(() => assertDataDirFits(db, { mode: 'prod', onchainNetwork: 'mainnet' })).not.toThrow();
    expect(() => assertDataDirFits(db, { mode: 'prod', onchainNetwork: undefined })).not.toThrow();
  });
});
