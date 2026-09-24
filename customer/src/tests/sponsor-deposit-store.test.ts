/**
 * 후원자 보증금 스토어 — 클레임이 풀렸다 다시 잡히면 인보이스가 또 온다
 *
 * 예전엔 첫 인보이스의 "환불됨"이 남아 **새 인보이스의 결제 칸이 안 떴다**. 알림은 새로고침 때 순서 없이
 * 다시 오므로 이벤트 시각으로 가른다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const load = () => import('../sponsor/deposit-store');

describe('보증금 인보이스 · 상태', () => {
  it('다시 잡은 클레임의 새 인보이스는 옛 상태를 물려받지 않는다', async () => {
    const s = await load();
    s.setDepositBolt11('o', 'lnbc1old', 100);
    s.setDepositStatus('o', 'cancelled', 200);
    s.setDepositBolt11('o', 'lnbc1new', 300);
    expect(s.getSnapshot().o).toEqual({ bolt11: 'lnbc1new', at: 300 });
  });

  it('옛 인보이스·옛 상태가 늦게 도착해도 덮지 않는다', async () => {
    const s = await load();
    s.setDepositBolt11('o', 'lnbc1new', 300);
    s.setDepositStatus('o', 'cancelled', 200); // 옛 인보이스의 환불
    s.setDepositBolt11('o', 'lnbc1old', 100);
    expect(s.getSnapshot().o).toEqual({ bolt11: 'lnbc1new', at: 300 });
  });

  it('상태가 인보이스보다 먼저 와도(재구독 순서) 그 인보이스의 상태면 남긴다', async () => {
    const s = await load();
    s.setDepositStatus('o', 'accepted', 400);
    s.setDepositBolt11('o', 'lnbc1new', 300);
    expect(s.getSnapshot().o).toMatchObject({ bolt11: 'lnbc1new', status: 'accepted' });
  });
});
