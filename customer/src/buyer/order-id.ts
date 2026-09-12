/**
 * 주문 식별자 생성
 *
 * orderId는 kind 30402의 `d` 태그이자 모든 kind 1111의 a-태그에 실리는 **공개값**이다.
 * 그래서 실세계 식별자를 그대로 쓰면 안 된다 — 파싱 주문이 쿠팡 주문번호를
 * orderId로 쓰던 시절에는 릴레이만 봐도 어떤 쿠팡 주문인지 드러났고(감사 A-3),
 * 남의 번호를 미리 등록해 그 주문을 영영 막는 선점 DoS도 가능했다(A-5).
 *
 * 수동 주문이 쓰던 방식을 그대로 공용화한다. 충돌은 Admin이 선착순으로 거르지만,
 * 실제로는 시각 + 난수 조합이라 부딪힐 일이 없다.
 */
export function newOrderId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
