/**
 * 후원자가 받은 계좌 정보 (온체인 트랙)
 *
 * 계좌는 **고객이 후원자에게 직접** NIP-44로 보낸다 — 어드민도 못 본다.
 * 그래서 이 스토어는 후원자 쪽에만 찬다.
 *
 * ⚠️ 이게 없으면 후원자는 **어디로 원화를 보낼지 모른 채** 마감 시계만 흐른다.
 * 실제로 그랬다(2026-09-21) — 수신 핸들러가 `account-info`를 안 다뤄서
 * 이벤트가 조용히 버려졌다.
 */
import { createStore, isAccountInfo, isStr, recordOf, shape, type AccountInfo } from '@sajwo-tracker/shared';

/**
 * 받은 계좌 + 커밋먼트 솔트. 분쟁 때 이 둘을 채팅에 공개하면 어드민이 고객 이벤트의
 * 공개 커밋먼트와 대조한다(계좌 이의 판정의 근거).
 */
export interface OnchainAccount {
  accountInfo: AccountInfo;
  salt: string;
}

type AccountMap = Record<string, OnchainAccount>;

// 키의 `-v2`는 이 헬퍼 전에 모양을 바꾸며 키째 갈아 끼운 흔적이다 — 이제는 `version`을 올린다
const store = createStore<AccountMap>({}, {
  key: 'onchain:account-info-v2',
  parse: recordOf(shape<OnchainAccount>({ accountInfo: isAccountInfo, salt: isStr })),
});

export const subscribeOnchainAccounts = store.subscribe;

export function getOnchainAccountsSnapshot(): Readonly<AccountMap> {
  return store.get();
}

export function getOnchainAccount(orderId: string): OnchainAccount | undefined {
  return store.get()[orderId];
}

/**
 * 먼저 온 것을 유지한다 — 계좌가 나간 뒤 바뀌면 **후원자가 이미 본 계좌와
 * 달라져** 원화가 엉뚱한 곳으로 가거나 입금이 확인되지 않는다.
 *
 * ⚠️ **"먼저 온 것 유지"는 발신자를 확인한 뒤에만 안전하다**. 전에는 아무나
 * 보낸 계좌가 여기 들어와서, 제3자가 먼저 쏜 가짜 계좌가 진짜 고객 계좌를 밀어냈다.
 * 발신자 확인은 부르는 쪽(`nostr/service.ts`)이 한다 — 이 스토어에는 **오더의 고객이
 * 보낸 것만** 들어온다.
 */
export function putOnchainAccount(orderId: string, account: OnchainAccount): void {
  if (store.get()[orderId]) return;
  store.update(prev => ({ ...prev, [orderId]: account }));
}

/** @testing-only */
export const _resetForTesting = store.reset;
