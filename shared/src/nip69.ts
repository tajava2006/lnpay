/**
 * NIP-69 P2P 오더 태그 — 오더 이벤트(`ORDER_KIND`)에 우리 태그와 나란히 싣는다.
 *
 * 우리 앱은 이 태그를 **읽지 않는다**(파서는 우리 태그만 본다). 다른 P2P 오더 모음이 우리 오더를 알아보라고
 * 다는 것이라, 우리 상태를 NIP-69의 다섯 상태로 접어 옮길 뿐이다. 접는 표는 트랙 모듈에 `Record`로 둔다 —
 * 상태가 늘면 빌드가 깨진다.
 *
 * 두 트랙 다 오더를 내는 쪽(고객)이 BTC를 **판다**: 라이트닝은 쿠팡 결제를 받고 sats를, 온체인은 원화를
 * 받고 BTC를 넘긴다. 둘 다 시세 그대로라 `premium`은 0이다(마진은 고객이 내고 후원자는 시세만큼 받는다).
 */

export type Nip69Status = 'pending' | 'canceled' | 'in-progress' | 'success' | 'expired';

export interface Nip69Order {
  status: Nip69Status;
  /** 거래되는 sats. 0 = 테이커가 받은 뒤 시세로 정한다(NIP-69 규약 그대로) */
  amountSat: number;
  /** 원화. 0 = 아직 안 정해졌다(온체인은 펀딩 컨펌 때 시세로 고정한다) */
  fiatKrw: number;
  network: string;
  layer: 'lightning' | 'onchain';
  /** `pending`이 끝나는 시각 — 그 뒤엔 `expired`가 된다 */
  expiresAt: number;
}

/** NIP-69 `y` — 오더를 낸 플랫폼 */
export const NIP69_PLATFORM = 'pairbuy';

export function nip69Tags(o: Nip69Order): string[][] {
  return [
    ['k', 'sell'],
    ['f', 'KRW'],
    ['s', o.status],
    ['amt', String(o.amountSat)],
    ['fa', String(o.fiatKrw)],
    ['pm', 'bank transfer'],
    ['premium', '0'],
    ['network', o.network],
    ['layer', o.layer],
    ['expires_at', String(o.expiresAt)],
    ['y', NIP69_PLATFORM],
    ['z', 'order'],
  ];
}
