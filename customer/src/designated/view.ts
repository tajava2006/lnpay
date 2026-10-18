/**
 * 지정 거래 — 화면이 쓰는 판단 (순수 함수, docs/LN-TRACK.md §7 · ONCHAIN-TRACK.md §10)
 *
 * 지정 거래는 상대(후원자)를 pubkey로 묶은, 보증금 없는 1:1 거래다. 오더북에는 안 뜨고, 지정된 후원자의 사주기 탭
 * "나를 지정한 거래"에만 뜬다. 여기는 "붙여넣은 주소를 쓸 수 있나", "어느 의뢰가 어디에 뜨나"만 정한다.
 */
import { checkCode, parsePubkeyInput, type Order } from '@sajwo-tracker/shared';
import { isClaimableLn } from '@sajwo-tracker/shared/ln';
import type { CustomerOrder } from '../buyer/types';

export type CounterpartyRead =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'self' }
  | { kind: 'ok'; pubkey: string; code: string };

/** 상대 주소 칸을 읽는다. 내 주소면 `self` — 자기 자신과는 거래할 수 없다 */
export function readCounterparty(text: string, myPubkey: string | null): CounterpartyRead {
  const t = text.trim().replace(/^nostr:/i, '');
  if (!t) return { kind: 'empty' };
  if (/^nsec1/i.test(t)) {
    return { kind: 'invalid', message: '비밀키(nsec)입니다 — 아무에게도 주면 안 되는 값입니다. 상대의 주소(npub)를 받으세요.' };
  }
  const pubkey = parsePubkeyInput(t);
  if (!pubkey) return { kind: 'invalid', message: '주소를 읽지 못했습니다. 상대에게 받은 npub1… 주소를 넣으세요.' };
  if (pubkey === myPubkey) return { kind: 'self' };
  return { kind: 'ok', pubkey, code: checkCode(pubkey) };
}

/** 나를 지정한, 지금 맡을 수 있는 라이트닝 의뢰 — 기한 임박순 */
export function designatedLnOffers(orders: readonly Order[], myPubkey: string | null, now: number): Order[] {
  if (!myPubkey) return [];
  return orders
    .filter(o => o.designatedSponsor === myPubkey && o.customerPubkey !== myPubkey && isClaimableLn(o, now))
    .sort((a, b) => a.expiration - b.expiration);
}

/** 라이트닝 오더북에 뜨는가 — 지정 거래는 오더북이 아니다(내가 맡은 건 "내가 사주는 중"에 따로 뜬다) */
export function isOnLnBook(order: Pick<Order, 'designatedSponsor'>): boolean {
  return !order.designatedSponsor;
}

/**
 * 이 기기의, 아직 아무도 수락하지 않은 라이트닝 지정 의뢰 수(보내기 전 초안 포함). 데몬은
 * `MAX_OPEN_DESIGNATED_PER_CUSTOMER`를 넘으면 말없이 무시한다(라이트닝 의뢰 요청엔 거절 통지가 없다) — 그래서 폼이
 * 만들 때 미리 막는다. 초안도 세는 건 초안을 여럿 만들어 두고 보내면 넘친 것이 "등록 확인 중"에 영영 머물기 때문이다
 */
export function openDesignatedLnCount(orders: readonly CustomerOrder[], now: number): number {
  return orders.filter(o => o.designatedSponsor && o.expiration > now
    && (o.adminState === undefined || o.adminState === 'requested')).length;
}
