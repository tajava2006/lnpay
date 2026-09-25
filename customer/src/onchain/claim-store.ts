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
  /** 클레임을 보낸 시각(ms). 그 뒤로 인보이스나 거절이 오기 전까지 폼을 잠근다 */
  requestedAt?: number;
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

/** 발행에 실패했다 — 데몬은 이 값을 모른다. 남겨 두면 폼이 기다리는 상태로 잠긴다 */
export function forgetMyClaim(orderId: string): void {
  const { [orderId]: _gone, ...rest } = claims;
  claims = rest;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(claims));
}

/** @testing-only */
export function _resetForTesting(): void {
  claims = {};
  localStorage.removeItem(STORAGE_KEY);
}

/** 데몬 시계와 브라우저 시계의 어긋남을 넉넉히 — 응답의 created_at은 데몬 시계다 */
const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * 클레임을 보내고 **답(보증금 인보이스나 거절)을 기다리는 중인가** — 그동안 폼을 잠근다(2026-09-25 드릴: 반응이
 * 없어 여러 번 누르게 됐다). 여러 번 눌러도 데몬은 같은 후원자의 두 번째 클레임을 버려 인보이스는 하나지만,
 * **앱은 누를 때마다 받을 주소·수수료율을 새로 기억했다** — 두 번째에 값을 바꾸면 데몬은 첫 값, 앱은 둘째 값을
 * 들고 있어 사전서명이 거절된다. 그래서 다시 보낼 때도 기억한 값 그대로 보낸다.
 *
 * 답의 시각은 이벤트 created_at(초, 데몬 시계)이다. 보낸 뒤에 온 답만 이 요청의 답으로 친다.
 */
export function pendingClaim(orderId: string, invoiceAt: number | undefined, rejectedAt: number | undefined): MyClaim | null {
  const mine = claims[orderId];
  if (!mine?.requestedAt) return null;
  const since = mine.requestedAt - CLOCK_SKEW_MS;
  if (invoiceAt !== undefined && invoiceAt * 1000 >= since) return null;
  if (rejectedAt !== undefined && rejectedAt * 1000 >= since) return null;
  return mine;
}
