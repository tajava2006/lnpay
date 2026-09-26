/**
 * 온체인 카드에 무엇을 띄우나 — 역할 × 상태 × 시각 표
 *
 * 이 트랙에선 버튼이 엉뚱한 때 열리면 원화가 헛되이 나간다(늦은 계좌·늦은 송금은 어드민도 안 받는다).
 * 카드는 `onchainCardView`를 그리기만 하므로 여기 표가 곧 화면의 규칙이다.
 */
import { describe, expect, it } from 'vitest';
import type { OnchainOrder } from '@sajwo-tracker/shared/onchain';
import { onchainCardView, type OnchainRole } from '../onchain/card-view';
import type { SignRequest } from '../onchain/sign-request-store';

const NOW = 1_800_000_000;

function order(over: Partial<OnchainOrder> = {}): OnchainOrder {
  return {
    orderId: 'o1', state: 'listed', customerPubkey: 'c', sponsorPubkey: 's', amountSat: 100_000,
    createdAt: NOW - 100, updatedAt: NOW - 100, expiration: NOW + 86_400, network: 'signet', raw: {},
    ...over,
  };
}

const view = (o: OnchainOrder, role: OnchainRole, requests: SignRequest[] = []) => onchainCardView(o, role, NOW, requests);

/** 켜진 칸 이름만 — 표를 읽기 쉽게 */
function shown(o: OnchainOrder, role: OnchainRole): string[] {
  const v = view(o, role);
  const flags: string[] = (['cancel', 'escrowAddress', 'presignStatus', 'remit', 'chatOpen'] as const).filter(k => v[k]);
  return v.account ? [...flags, `account:${v.account}`] : flags;
}

describe('역할 × 상태', () => {
  it.each([
    ['listed', 'customer', {}, ['cancel']],
    ['listed', 'sponsor', {}, []],
    ['bonded', 'customer', {}, ['escrowAddress']],
    ['funded', 'sponsor', {}, ['presignStatus']],
    // 결정(환불)이 박히면 사전서명은 끝이다 — 앞으로 가는 버튼을 열지 않는다
    ['funded', 'sponsor', { settlementKind: 'refund:sponsor-timeout' }, []],
    ['presigned', 'customer', { accountDeadline: NOW + 60 }, ['account:form']],
    ['presigned', 'customer', { accountDeadline: NOW - 1 }, ['account:late']],
    // 마감을 모르면 지난 것으로 본다 — 모르는 마감에 계좌를 내보내지 않는다
    ['presigned', 'customer', {}, ['account:late']],
    ['presigned', 'customer', { accountSentAt: NOW - 10 }, ['chatOpen']],
    ['presigned', 'sponsor', {}, ['remit']],
    ['presigned', 'sponsor', { accountSentAt: NOW - 10 }, ['remit', 'chatOpen']],
    ['remitted', 'customer', {}, ['chatOpen']],
    ['disputed', 'sponsor', {}, ['chatOpen']],
    ['refunding', 'customer', { settlementKind: 'refund:account-disputed' }, ['chatOpen']],
    ['refunding', 'customer', { settlementKind: 'refund:sponsor-timeout' }, []],
    ['released', 'customer', {}, []],
  ] as const)('%s · %s %o → %o', (state, role, over, expected) => {
    expect(shown(order({ state, ...over }), role)).toEqual(expected);
  });
});

describe('서명 요청', () => {
  const req = (purpose: SignRequest['purpose']): SignRequest => ({ orderId: 'o1', purpose, psbt: 'p', receivedAt: 1 });

  /** 요청은 새로고침마다 릴레이에서 다시 온다 — 저장소에 있다는 것만으로 띄우면 안 된다 */
  it('FSM이 허락하는 것만 — 환불 중엔 환불 서명만, 릴리스는 숨긴다', () => {
    const v = view(order({ state: 'refunding', settlementKind: 'refund:sponsor-timeout' }), 'customer',
      [req('refund'), req('release')]);
    expect(v.actionable.map(r => r.purpose)).toEqual(['refund']);
  });

  it('구조(rescue)는 FSM 밖이라 언제나', () => {
    expect(view(order({ state: 'released' }), 'customer', [req('rescue'), req('release')]).actionable
      .map(r => r.purpose)).toEqual(['rescue']);
  });
});
