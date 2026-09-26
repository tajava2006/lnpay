/**
 * 내 키 — 보기 · 다른 기기로 옮기기
 *
 * 이 앱엔 계정이 없다. nostr 키 하나가 곧 나이고, 거래 기록은 그 키로 릴레이에서 다시 불러온다
 * (`nostr/own-requests.ts` · `onchain/nostr/own-requests.ts`). 그래서 백업할 건 **키 하나**다.
 *
 * 키를 암호화해 어딘가 올리는 건 소용이 없다 — 풀 열쇠가 또 필요하고, 그 열쇠도 결국 어딘가 평문으로 있어야
 * 한다. 이 사슬이 끝나는 곳은 유저의 비밀번호 관리자나 종이다. 앱은 키를 보여주고, 보관은 유저가 한다.
 */
import { decode, nsecEncode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';
import {
  STORAGE_KEYS, getSecretKey, idbClearAll, isTerminalState, storage, type NostrKeypair,
} from '@sajwo-tracker/shared';
import { isOnchainTerminal } from '@sajwo-tracker/shared/onchain';
import { myOnchainOrders } from './onchain/store';
import { unsubscribeFromPush } from './push/subscribe';
import { getSnapshot as getLnOrders } from './sponsor/order-store';

export async function myNsec(): Promise<string> {
  return nsecEncode(await getSecretKey(storage));
}

/** `nsec1…` 또는 hex 64자 → 비밀키. 못 읽으면 null */
export function parseSecretKey(input: string): Uint8Array | null {
  const text = input.trim();
  if (text.startsWith('nsec1')) {
    try {
      const decoded = decode(text);
      return decoded.type === 'nsec' ? decoded.data : null;
    } catch {
      return null;
    }
  }
  if (!/^[0-9a-fA-F]{64}$/.test(text)) return null;
  return Uint8Array.from(text.match(/.{2}/g)!.map(b => parseInt(b, 16)));
}

function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    work.then(() => undefined, () => undefined),
    new Promise<void>(resolve => setTimeout(resolve, ms)),
  ]);
}

/** 지금 키로 참여 중인 진행 중 거래 수 — 키를 바꾸기 전에 경고한다 */
export function activeTradeCount(myPubkey: string): number {
  const ln = Object.values(getLnOrders())
    .filter(o => (o.customerPubkey === myPubkey || o.sponsorPubkey === myPubkey) && !isTerminalState(o.state));
  const onchain = myOnchainOrders(myPubkey).filter(o => !isOnchainTerminal(o.state));
  return ln.length + onchain.length;
}

/**
 * 이 기기의 키를 바꾼다.
 *
 * 옛 키의 로컬 기록(주문·채팅·설정)을 전부 지우고 새 키로 다시 연다 — 거래 기록은 새 키로 릴레이에서 다시
 * 불러온다. 이 브라우저의 웹 푸시는 옛 키 앞으로 등록돼 있어 끊는다(알림은 새 키로 다시 켠다).
 */
export async function replaceKey(sk: Uint8Array): Promise<void> {
  // 서비스 워커가 없으면 `ready`가 영영 안 온다 — 기다리다 키 교체가 안 되는 것보다 넘어가는 게 낫다
  // (옛 구독은 데몬이 404로 정리한다). IDB는 지우지 않고 비운다 — 지우기는 다른 탭 때문에 멈출 수 있다
  await settleWithin(unsubscribeFromPush(), 3000);
  await settleWithin(idbClearAll(), 3000);
  localStorage.clear();
  const keypair: NostrKeypair = { secretKey: Array.from(sk), publicKey: getPublicKey(sk) };
  await storage.set(STORAGE_KEYS.KEYPAIR, keypair);
  location.reload();
}
