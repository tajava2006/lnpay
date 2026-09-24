/**
 * 주문 번호 모양 — 유저 앱이 만드는 것(`Date.now().toString(36)` + 난수).
 *
 * 시드 파생 scope(`…/<orderId>/…`)와 d 태그에 들어가므로 **좁게** 받는다. 구분자 `/`가 섞이면 파생이 깨진다.
 */
export const ORDER_ID_PATTERN = /^[0-9A-Za-z_-]{4,64}$/;

export function isOrderId(value: string | null | undefined): value is string {
  return typeof value === 'string' && ORDER_ID_PATTERN.test(value);
}
