/**
 * 내가 클레임할 때 낸 값 (후원자 역할)
 *
 * 받을 주소와 희망 feerate는 **내가 정한 것**이고(§6.1b), 어드민에게는
 * 암호문으로만 보낸다. 오더 이벤트에는 안 실리므로 **여기 없으면 나중에
 * 사전서명을 만들 수 없다.**
 *
 * localStorage만 쓴다 — 잃어도 자금이 잠기진 않는다(어드민에게 다시 내면 된다).
 */
const STORAGE_KEY = 'onchain:my-claims';

export interface MyClaim {
  orderId: string;
  payoutAddress: string;
  feerateSatPerVb: number;
}

type ClaimMap = Record<string, MyClaim>;

function load(): ClaimMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ClaimMap) : {};
  } catch {
    return {};
  }
}

let claims: ClaimMap = load();

export function rememberMyClaim(claim: MyClaim): void {
  claims = { ...claims, [claim.orderId]: claim };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(claims));
}

export function getMyClaim(orderId: string): MyClaim | undefined {
  return claims[orderId];
}

/** @testing-only */
export function _resetForTesting(): void {
  claims = {};
  localStorage.removeItem(STORAGE_KEY);
}
