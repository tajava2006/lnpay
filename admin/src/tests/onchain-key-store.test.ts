/**
 * 어드민 주문별 키 (PLAN-ONCHAIN-TRACK §3.2 · 공격 M)
 *
 * **이 키를 잃으면 그 주문의 분쟁 중재가 영구 불가**다. 그래서 여기서 지키는 건
 * 딱 둘이다: ① 백업이 실패하면 **진행을 막는다** ② 재시도해도 **키가 안 바뀐다**.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isXonlyHex } from '@sajwo-tracker/shared/onchain';

// NIP-46 signer와 릴레이를 흉내 낸다. 암호화는 "되돌릴 수 있는 변환"이면 충분하다.
const signer = {
  nip44Encrypt: vi.fn(async (_pk: string, text: string) => `enc:${text}`),
  nip44Decrypt: vi.fn(async (_pk: string, cipher: string) => {
    if (!cipher.startsWith('enc:')) throw new Error('복호화 실패');
    return cipher.slice(4);
  }),
  signEvent: vi.fn(async (t: object) => ({ ...t, id: 'evt', sig: 'sig' })),
};
let signerPresent = true;
vi.mock('../nostr/nip46', () => ({ getSigner: () => (signerPresent ? signer : null) }));

/** 릴레이: publish 성공 여부와 저장된 이벤트를 테스트가 조종한다 */
let publishOk = true;
let stored: { content: string } | null = null;
vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    publish(relays: string[], event: { content: string }) {
      if (!publishOk) return relays.map(() => Promise.reject(new Error('relay down')));
      stored = event;
      return relays.map(() => Promise.resolve('ok'));
    }
    async get() { return stored; }
    destroy() {}
  },
}));

vi.mock('@sajwo-tracker/shared', async importOriginal => ({
  ...(await importOriginal<object>()),
  getWriteRelays: async () => ['wss://relay.test'],
}));

const { createOrderKeyWithBackup, getOrderKey, loadOnchainKeys, _resetForTesting } =
  await import('../onchain/key-store');

beforeEach(() => {
  _resetForTesting();
  stored = null;
  publishOk = true;
  signerPresent = true;
  vi.clearAllMocks();
});

describe('키 생성', () => {
  it('유효한 x-only 키를 만들고 로컬에 남긴다', async () => {
    const key = await createOrderKeyWithBackup('o-1');
    expect(isXonlyHex(key.xonly)).toBe(true);
    expect(key.privkey).toHaveLength(32);
    expect(localStorage.getItem('admin:onchain-keys')).toContain('enc:');
  });

  it('주문마다 다른 키', async () => {
    const a = await createOrderKeyWithBackup('o-1');
    const b = await createOrderKeyWithBackup('o-2');
    expect(a.xonly).not.toBe(b.xonly);
  });

  /**
   * 재시도로 키가 바뀌면 **이미 발행된 주소를 못 여는 키**가 생긴다.
   * 그 주문은 중재도 환불도 불가능해진다.
   */
  it('같은 주문을 다시 불러도 키가 안 바뀐다', async () => {
    const first = await createOrderKeyWithBackup('o-1');
    const again = await createOrderKeyWithBackup('o-1');
    expect(again.xonly).toBe(first.xonly);
  });
});

describe('백업이 실패하면 진행을 막는다 (공격 M)', () => {
  /**
   * localStorage만으로는 부족하다 — 그 기기를 잃으면 끝이다. 그래서 던진다.
   * 호출부는 이 예외를 보고 **주소 발행을 멈춰야** 한다.
   */
  it('릴레이 발행 실패 시 던진다', async () => {
    publishOk = false;
    await expect(createOrderKeyWithBackup('o-1')).rejects.toThrow(/백업 발행 실패/);
  });

  /** 던지더라도 **키는 로컬에 남긴다** — 날려버리면 그게 더 나쁘다. */
  it('실패해도 로컬 키는 보존되고, 재시도하면 같은 키가 백업된다', async () => {
    publishOk = false;
    await expect(createOrderKeyWithBackup('o-1')).rejects.toThrow();
    const saved = await getOrderKey('o-1');
    expect(saved).not.toBeNull();

    publishOk = true;
    const retried = await createOrderKeyWithBackup('o-1');
    expect(retried.xonly).toBe(saved!.xonly);
    expect(stored).not.toBeNull();
  });

  it('signer가 없으면 만들지 않는다', async () => {
    signerPresent = false;
    await expect(createOrderKeyWithBackup('o-1')).rejects.toThrow(/signer/);
  });

  it('orderId가 비면 거부한다', async () => {
    await expect(createOrderKeyWithBackup('')).rejects.toThrow(/orderId/);
  });
});

describe('복원', () => {
  it('로컬이 비어 있으면 릴레이에서 되살린다 (기기 교체)', async () => {
    const key = await createOrderKeyWithBackup('o-1');

    // 기기를 바꾼 상황: 로컬만 날아가고 릴레이 백업은 남아 있다
    _resetForTesting();
    expect(localStorage.getItem('admin:onchain-keys')).toBeNull();

    const restored = await getOrderKey('o-1');
    expect(restored?.xonly).toBe(key.xonly);
    // 복원한 뒤에는 로컬 캐시도 다시 채운다
    expect(localStorage.getItem('admin:onchain-keys')).toContain('enc:');
  });

  it('없는 주문은 null', async () => {
    expect(await getOrderKey('nope')).toBeNull();
  });

  /**
   * 복호화가 안 되는 로컬 캐시를 **지우지 않는다.** signer가 잠깐 없을 수도 있고,
   * 그때 지우면 유일본을 날린다.
   */
  it('로컬 캐시가 안 열려도 지우지 않는다', async () => {
    localStorage.setItem('admin:onchain-keys', 'garbage-not-enc');
    await loadOnchainKeys();
    expect(localStorage.getItem('admin:onchain-keys')).toBe('garbage-not-enc');
  });

  it('릴레이 백업이 손상돼 있으면 빈 맵으로 시작한다 (던지지 않는다)', async () => {
    stored = { content: 'enc:{"o-1":"not-a-key"}' };
    expect(await loadOnchainKeys()).toEqual({});
  });
});
