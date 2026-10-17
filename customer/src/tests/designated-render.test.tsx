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

/** React가 알아듣게 값을 넣는다 (네이티브 setter + input 이벤트) */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
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
