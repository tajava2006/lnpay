/**
 * 지정 거래 화면 — 실제 렌더 (docs/LN-TRACK.md §7 · ONCHAIN-TRACK.md §10)
 *
 * 순수 판단은 `designated.test.ts`가 본다. 여기는 **화면이 그 판단대로 잠기고 풀리는지** — 주소를 넣고, 확인 코드 대조와
 * 위험 고지를 **둘 다** 체크해야만 만들기·수락 버튼이 열리는지, 만들면 지정 상대가 실린 의뢰가 저장되는지.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { checkCode, type Order } from '@sajwo-tracker/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = getPublicKey(generateSecretKey());
const OTHER = getPublicKey(generateSecretKey());

vi.mock('../hooks', () => ({ useMyPubkey: () => ME }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** React가 알아듣게 값을 넣는다 — 프로토타입의 네이티브 setter를 `this = input`으로 부르고 input 이벤트 */
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const button = (text: string) =>
  [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement;
const checkboxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

describe('라이트닝 의뢰 폼 — 지정 거래', () => {
  it('주소 → 확인 코드 → 두 체크가 다 돼야 만들 수 있고, 만들면 지정 상대가 실린다', async () => {
    const { OrderForm } = await import('../buyer/components/OrderForm');
    const store = await import('../buyer/order-store');
    act(() => root.render(<OrderForm />));

    act(() => button('지정 거래').click());
    const submit = () => button('지정 거래 만들기');
    expect(submit().disabled).toBe(true);

    type(host.querySelector<HTMLInputElement>('input[placeholder^="npub1"]')!, nip19.npubEncode(OTHER));
    expect(host.textContent).toContain(checkCode(OTHER));
    expect(host.textContent).toContain(checkCode(ME)); // 내 코드도 보여 준다 — 상대가 대조한다
    expect(submit().disabled).toBe(true);

    const [code, risk] = checkboxes();
    act(() => code!.click());
    expect(submit().disabled).toBe(true); // 하나만으로는 안 열린다
    act(() => risk!.click());
    expect(submit().disabled).toBe(false);

    type(host.querySelector<HTMLInputElement>('input[type="number"]')!, '32900');
    act(() => submit().click());
    const orders = Object.values(store.getSnapshot());
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ price: 32_900, designatedSponsor: OTHER });
  });

  it('주소를 바꾸면 체크가 풀린다 — 다른 주소에 대한 동의가 남지 않게', async () => {
    const { OrderForm } = await import('../buyer/components/OrderForm');
    act(() => root.render(<OrderForm />));
    act(() => button('지정 거래').click());
    const input = host.querySelector<HTMLInputElement>('input[placeholder^="npub1"]')!;
    type(input, nip19.npubEncode(OTHER));
    for (const c of checkboxes()) act(() => c.click());
    expect(button('지정 거래 만들기').disabled).toBe(false);

    type(input, nip19.npubEncode(getPublicKey(generateSecretKey())));
    expect(checkboxes().every(c => !c.checked)).toBe(true);
    expect(button('지정 거래 만들기').disabled).toBe(true);
  });

  it('내 주소를 넣으면 거절한다', async () => {
    const { OrderForm } = await import('../buyer/components/OrderForm');
    act(() => root.render(<OrderForm />));
    act(() => button('지정 거래').click());
    type(host.querySelector<HTMLInputElement>('input[placeholder^="npub1"]')!, nip19.npubEncode(ME));
    expect(host.textContent).toContain('내 주소입니다');
    expect(checkboxes()).toHaveLength(0);
  });
});

describe('라이트닝 의뢰 폼 — 지정 의뢰 개수 상한', () => {
  /** 상한보다 하나 적게 깔아 두고 폼으로 하나 더 만든다 → 됐는지 */
  async function createWith(open: number): Promise<{ created: boolean; alerted: boolean }> {
    const { OrderForm } = await import('../buyer/components/OrderForm');
    const store = await import('../buyer/order-store');
    store.clearDeletableOrders(() => true); // 저장소는 테스트 사이에 메모리로 이어진다
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < open; i++) {
      store.addOrder({ orderId: `d${i}`, price: 1000, memo: '', createdAt: now, expiration: now + 86_400, designatedSponsor: OTHER });
    }
    const alerts = vi.fn();
    vi.stubGlobal('alert', alerts);
    act(() => root.render(<OrderForm />));
    act(() => button('지정 거래').click());
    type(host.querySelector<HTMLInputElement>('input[placeholder^="npub1"]')!, nip19.npubEncode(OTHER));
    for (const c of checkboxes()) act(() => c.click());
    type(host.querySelector<HTMLInputElement>('input[type="number"]')!, '32900');
    act(() => button('지정 거래 만들기').click());
    vi.unstubAllGlobals();
    return {
      created: Object.keys(store.getSnapshot()).length === open + 1,
      alerted: alerts.mock.calls.some(c => /수락을 기다리는 지정 거래가 이미/.test(String(c[0]))),
    };
  }

  it('수락 대기 지정 의뢰가 상한이면 만들지 않고 알린다 — 라이트닝은 데몬 거절이 유저에게 안 닿는다', async () => {
    const { MAX_OPEN_DESIGNATED_PER_CUSTOMER } = await import('@sajwo-tracker/shared');
    expect(await createWith(MAX_OPEN_DESIGNATED_PER_CUSTOMER)).toEqual({ created: false, alerted: true });
  });

  it('상한보다 적으면 만든다', async () => {
    const { MAX_OPEN_DESIGNATED_PER_CUSTOMER } = await import('@sajwo-tracker/shared');
    expect(await createWith(MAX_OPEN_DESIGNATED_PER_CUSTOMER - 1)).toEqual({ created: true, alerted: false });
  });
});

describe('나를 지정한 거래 — 수락 카드', () => {
  it('고객 확인 코드를 보여 주고, 두 체크가 다 돼야 수락이 열린다', async () => {
    const { DesignatedOfferCard } = await import('../sponsor/components/DesignatedOfferCard');
    const now = Math.floor(Date.now() / 1000);
    const order: Order = {
      orderId: 'd1', state: 'requested', customerPubkey: OTHER, price: 32_900, createdAt: now, updatedAt: now,
      expiration: now + 86_400, designatedSponsor: ME, raw: {},
    };
    act(() => root.render(<DesignatedOfferCard order={order} now={now} />));
    expect(host.textContent).toContain(checkCode(OTHER));
    expect(button('수락').disabled).toBe(true);
    for (const c of checkboxes()) act(() => c.click());
    expect(button('수락').disabled).toBe(false);
  });
});

describe('온체인 팔기 폼 — 지정 거래', () => {
  it('상대가 정해지기 전엔 만들 수 없고, 보증금 안내 대신 지정 거래 안내가 뜬다', async () => {
    const { OnchainOrderForm } = await import('../onchain/components/OnchainOrderForm');
    act(() => root.render(<OnchainOrderForm />));
    expect(host.textContent).toContain('보증금 인보이스가 옵니다');
    act(() => button('지정 거래').click());
    expect(host.textContent).not.toContain('보증금 인보이스가 옵니다');
    expect(host.textContent).toContain('보증금 없이 바로 의뢰가 생기고');
    expect(button('지정 거래 만들기').disabled).toBe(true);
    type(host.querySelector<HTMLInputElement>('input[placeholder^="npub1"]')!, nip19.npubEncode(OTHER));
    for (const c of checkboxes()) act(() => c.click());
    expect(button('지정 거래 만들기').disabled).toBe(false);
  });
});

/**
 * 지정 온체인 거래는 보증금이 없다(ONCHAIN-TRACK §10) — 지나가는 칸마다 보증금·몰수를 말하지 않아야 한다(2026-10-19 리뷰 3차).
 * 같은 칸을 공개 거래로 그리면 그대로 말한다.
 */
describe('온체인 지정 거래 — 칸마다 보증금·몰수를 말하지 않는다', () => {
  const now = Math.floor(Date.now() / 1000);
  const order = (designated: boolean, over: Record<string, unknown> = {}) => ({
    orderId: 'oc-dz1', state: 'presigned' as const, customerPubkey: ME, sponsorPubkey: OTHER, amountSat: 100_000,
    createdAt: now, updatedAt: now, expiration: now + 86_400, network: 'signet' as const, raw: {},
    ...(designated ? { designatedSponsor: OTHER } : {}), ...over,
  });
  /** 지금 그려진 화면이 보증금·몰수를 말하는가 */
  const says = () => /보증금|몰수/.test(host.textContent ?? '');

  it('계좌 입력 폼', async () => {
    const { AccountInfoForm } = await import('../onchain/components/AccountInfoForm');
    act(() => root.render(<AccountInfoForm order={order(true)} />));
    expect(says()).toBe(false);
    act(() => root.render(<AccountInfoForm order={order(false)} />));
    expect(says()).toBe(true);
  });

  it('사전서명 재입력(이 기기에 클레임 기록이 없을 때)', async () => {
    const { PresignStatus } = await import('../onchain/components/PresignStatus');
    const funded = (d: boolean) => order(d, { state: 'funded', fundedAt: now, presignDeadline: now + 900 });
    act(() => root.render(<PresignStatus order={funded(true)} now={now} />));
    expect(host.textContent).toContain('받을 주소를 다시 입력하세요');
    expect(says()).toBe(false);
    act(() => root.render(<PresignStatus order={funded(false)} now={now} />));
    expect(says()).toBe(true);
  });

  it('의뢰 내리기', async () => {
    const { CancelOrderPanel } = await import('../onchain/components/CancelOrderPanel');
    act(() => root.render(<CancelOrderPanel order={order(true, { state: 'listed' })} />));
    act(() => button('의뢰 내리기').click());
    expect(says()).toBe(false);
    expect(host.textContent).not.toContain('오더북');
  });

  it('마감 카운트다운(1시간 안이면 경고문이 뜬다)', async () => {
    const { DeadlineCountdown } = await import('../onchain/components/DeadlineCountdown');
    const soon = (d: boolean) => order(d, { state: 'presigned', presignedAt: now, accountDeadline: now + 600 });
    act(() => root.render(<DeadlineCountdown order={soon(true)} role="customer" />));
    expect(host.textContent).toContain('계좌 전달 마감');
    expect(says()).toBe(false);
    act(() => root.render(<DeadlineCountdown order={soon(false)} role="customer" />));
    expect(says()).toBe(true);
  });
});
