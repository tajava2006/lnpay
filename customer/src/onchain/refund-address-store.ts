/**
 * 내가 의뢰 때 낸 환불 주소 (고객 역할)
 *
 * 환불·고객승·구조 tx는 이 주소로 온다(리뷰 #8). 어드민이 보낸 환불 PSBT에 서명하기
 * 전에 **받는 주소가 이것인지** 대조하는 데 쓴다 — 대조하지 않으면 악의적이거나
 * 침해된 어드민이 "환불"이라며 자기 주소로 보내는 tx에 서명을 받아간다.
 *
 * 이 기기에만 있다. 다른 기기에서 키를 가져온 경우엔 여기 없으므로, 화면이 유저에게
 * 주소를 **다시 입력**하게 해서 대조한다(보여주고 "맞다"를 누르게 하면 대조가 아니다).
 */
const STORAGE_KEY = 'onchain:refund-addresses';

type AddressMap = Record<string, string>;

function load(): AddressMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AddressMap) : {};
  } catch {
    return {};
  }
}

let addresses: AddressMap = load();

export function rememberRefundAddress(orderId: string, address: string): void {
  addresses = { ...addresses, [orderId]: address.trim() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(addresses));
}

export function getRefundAddress(orderId: string): string | undefined {
  return addresses[orderId];
}

/** @testing-only */
export function _resetForTesting(): void {
  addresses = {};
  localStorage.removeItem(STORAGE_KEY);
}
