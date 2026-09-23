/**
 * 어드민 주문별 키 (PLAN-ONCHAIN-TRACK §3.2 · 공격 M)
 *
 * **이 키를 잃으면 그 주문의 분쟁 중재가 영구 불가**다. 여기서 지키는 건:
 * ① 백업이 실패하면 **진행을 막는다** ② 재시도해도 **키가 안 바뀐다**
 * ③ (리뷰 #8) **한 주문을 쓰는 일이 다른 주문의 키를 지울 수 없다**
 * ④ (리뷰 #8) **읽지 못한 건 '모름'이다** — 빈 것으로 치고 덮어쓰지 않는다
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

/** 릴레이: d 태그별로 마지막 이벤트를 들고 있는다 (replaceable) */
let publishOk = true;
const relay = new Map<string, { content: string; tags: string[][] }>();
const dOf = (e: { tags: string[][] }) => e.tags.find(t => t[0] === 'd')?.[1] ?? '';
vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    publish(relays: string[], event: { content: string; tags: string[][] }) {
      if (!publishOk) return relays.map(() => Promise.reject(new Error('relay down')));
      relay.set(dOf(event), event);
      return relays.map(() => Promise.resolve('ok'));
    }
    async get(_relays: string[], filter: { '#d': string[] }) {
      return relay.get(filter['#d'][0]!) ?? null;
    }
    destroy() {}
  },
}));

vi.mock('@sajwo-tracker/shared', async importOriginal => ({
  ...(await importOriginal<object>()),
  getWriteRelays: async () => ['wss://relay.test'],
}));

const { createOrderKeyWithBackup, getOrderKey, _resetForTesting, _forgetMemoryForTesting } =
  await import('../onchain/key-store');

/** 새 세션 흉내 — 메모리만 비우고 로컬 저장소와 릴레이는 그대로 */
function newSession(): void {
  _forgetMemoryForTesting();
}

/** 기기 교체 흉내 — 로컬까지 비운다 */
function newDevice(): void {
  _resetForTesting();
}

beforeEach(() => {
  _resetForTesting();
  relay.clear();
  publishOk = true;
  signerPresent = true;
  vi.clearAllMocks();
});

describe('키 생성', () => {
  it('유효한 x-only 키를 만들고 로컬에 남긴다', async () => {
    const key = await createOrderKeyWithBackup('o-1');
    expect(isXonlyHex(key.xonly)).toBe(true);
    expect(key.privkey).toHaveLength(32);
    expect(localStorage.getItem('admin:onchain-key:o-1')).toContain('enc:');
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
  it('같은 주문을 다시 불러도 키가 안 바뀐다 (새 세션에서도)', async () => {
    const first = await createOrderKeyWithBackup('o-1');
    newSession();
    const again = await createOrderKeyWithBackup('o-1');
    expect(again.xonly).toBe(first.xonly);
  });

  it('주문마다 릴레이 백업이 따로 있다', async () => {
    await createOrderKeyWithBackup('o-1');
    await createOrderKeyWithBackup('o-2');
    expect([...relay.keys()].sort()).toEqual([
      expect.stringMatching(/:o-1$/), expect.stringMatching(/:o-2$/),
    ].sort());
  });
});

describe('백업이 실패하면 진행을 막는다 (공격 M)', () => {
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
    expect(relay.size).toBe(1);
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
    newDevice();
    expect(localStorage.getItem('admin:onchain-key:o-1')).toBeNull();

    const restored = await getOrderKey('o-1');
    expect(restored?.xonly).toBe(key.xonly);
    // 복원한 뒤에는 로컬도 다시 채운다
    expect(localStorage.getItem('admin:onchain-key:o-1')).toContain('enc:');
  });

  it('없는 주문은 null', async () => {
    expect(await getOrderKey('nope')).toBeNull();
  });

  it('주문의 어드민 키와 다르면 던진다 (엉뚱한 키로 서명하지 않는다)', async () => {
    await createOrderKeyWithBackup('o-1');
    await expect(getOrderKey('o-1', 'ab'.repeat(32))).rejects.toThrow(/다르다/);
  });

  /** 옛 방식(맵 하나)으로 백업된 키도 읽는다 — 그 전에 만든 주문이 거기 있다 */
  it('옛 맵 백업(로컬·릴레이)을 읽는다', async () => {
    const hex = '11'.repeat(32);
    localStorage.setItem('admin:onchain-keys', `enc:${JSON.stringify({ 'old-1': hex })}`);
    expect((await getOrderKey('old-1'))?.privkey).toEqual(Uint8Array.from({ length: 32 }, () => 0x11));

    newDevice();
    relay.set('onchain-keys:sajwo-tracker-onchain-dev', { content: `enc:${JSON.stringify({ 'old-2': hex })}`, tags: [] });
    relay.set('onchain-keys:sajwo-tracker-onchain', { content: `enc:${JSON.stringify({ 'old-2': hex })}`, tags: [] });
    expect(await getOrderKey('old-2')).not.toBeNull();
  });
});

describe('리뷰 #8 — 키가 통째로 날아가던 경로', () => {
  /**
   * K1. 번커 타임아웃 한 번. 전에는 로컬·릴레이 복호화가 둘 다 실패하면 빈 맵을
   * 캐시했고, 번커가 돌아온 뒤 다음 클레임이 **로컬과 릴레이를 새 키 하나짜리 맵으로
   * 덮어써** 진행 중인 모든 주문의 키가 사라졌다.
   */
  it('복호화가 실패하면 "없음"으로 치지 않고 던진다 — 아무것도 덮어쓰지 않는다', async () => {
    const old = await createOrderKeyWithBackup('old-1');
    newSession();

    signer.nip44Decrypt.mockRejectedValueOnce(new Error('bunker timeout'));
    await expect(getOrderKey('old-1')).rejects.toThrow(/읽지 못했다/);

    // 번커가 돌아온 뒤 다른 주문의 키를 만든다
    await createOrderKeyWithBackup('new-2');
    // 옛 키는 로컬에도 릴레이에도 그대로다
    expect((await getOrderKey('old-1'))?.xonly).toBe(old.xonly);
    newDevice();
    expect((await getOrderKey('old-1'))?.xonly).toBe(old.xonly);
  });

  it('기존 키를 못 읽으면 새 키를 만들지 않는다 (같은 주문에 키가 둘이 되지 않게)', async () => {
    const first = await createOrderKeyWithBackup('o-1');
    newSession();
    signer.nip44Decrypt.mockRejectedValueOnce(new Error('bunker timeout'));
    await expect(createOrderKeyWithBackup('o-1')).rejects.toThrow(/읽지 못해/);
    expect((await createOrderKeyWithBackup('o-1')).xonly).toBe(first.xonly);
  });

  /**
   * K2. 기기 인수. 전에는 로컬 맵이 있으면 릴레이를 안 봐서, 낡은 로컬을 가진 기기가
   * 새 키를 만드는 순간 **다른 기기가 만든 키를 백업에서 지웠다.** 주문별 이벤트라
   * 이제 한 주문의 쓰기가 다른 주문을 건드릴 수 없다.
   */
  it('다른 기기가 만든 키를 지우지 않고, 필요하면 릴레이에서 가져온다', async () => {
    // 기기 B가 old-1을 만들었다
    await createOrderKeyWithBackup('old-1');
    const deviceBLocal = localStorage.getItem('admin:onchain-key:old-1')!;

    // 기기 A가 a-2를 만들었다 (B의 로컬에는 없다)
    newDevice();
    const a2 = await createOrderKeyWithBackup('a-2');

    // 다시 B — 로컬엔 old-1뿐
    newDevice();
    localStorage.setItem('admin:onchain-key:old-1', deviceBLocal);
    await createOrderKeyWithBackup('b-3');

    expect(relay.size).toBe(3); // 셋 다 백업에 남아 있다
    expect((await getOrderKey('a-2'))?.xonly).toBe(a2.xonly); // B도 A의 주문에 서명할 수 있다
  });
});
