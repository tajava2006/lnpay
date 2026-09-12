/**
 * 후원자와 오더의 관계 판정
 *
 * 오더북은 진행 중인 남의 거래까지 전부 보여준다(상태는 공개 정보다).
 * 그래서 "내가 손댈 수 있는 건지"를 화면에 분명히 드러내야 한다.
 *
 * 판정은 오직 오더 상태 + pubkey로만 한다. kind 1111 클레임 이벤트가
 * 릴레이에 남아있는지는 보지 않는다 — 중간에 파토나서 Admin이 클레임을
 * 철회하면(revertClaim) 오더는 requested로 돌아오고 sponsorPubkey도 지워지지만,
 * 남이 보냈던 클레임 이벤트는 릴레이에 그대로 남기 때문이다.
 * 이벤트를 근거로 삼으면 다시 열린 주문을 영영 잠긴 것으로 오판한다.
 */
import type { Order } from './types';

export type SponsorRelation =
  /** requested — 누구나 클레임 가능 */
  | 'open'
  /** 내가 고객으로 올린 주문 — 자기 클레임은 금지다 */
  | 'own'
  /** 내가 후원자로 클레임한 거래 */
  | 'mine'
  /** 다른 후원자가 진행 중 — 손댈 수 없음 */
  | 'taken'
  /** 내 pubkey를 아직 모름 (로딩 중) — 단정하지 않는다 */
  | 'unknown';

export function sponsorRelation(
  order: Pick<Order, 'state' | 'sponsorPubkey' | 'customerPubkey'>,
  myPubkey: string | null | undefined,
): SponsorRelation {
  if (!myPubkey) {
    // 내 키를 모르면 requested만 확실히 열려 있다고 말할 수 있다.
    return order.state === 'requested' ? 'open' : 'unknown';
  }

  // 내가 올린 주문은 상태와 무관하게 내 것이다. requested보다 먼저 본다 —
  // 그러지 않으면 내 주문이 내 오더북에 클레임 가능한 것으로 뜬다.
  if (order.customerPubkey === myPubkey) return 'own';

  if (order.state === 'requested') return 'open';
  if (order.sponsorPubkey && order.sponsorPubkey === myPubkey) return 'mine';
  return 'taken';
}
