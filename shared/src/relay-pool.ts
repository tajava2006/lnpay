/**
 * 구독용 릴레이 pool 생성
 *
 * ── 왜 따로 두는가
 *
 * `new SimplePool()`은 기본적으로 ping도 재연결도 하지 않는다. 발행처럼 매번
 * 새로 만들고 바로 버리는 pool은 그래도 되지만, **구독 pool은 오래 살아 있어서**
 * 연결이 조용히 죽으면 그 뒤로 이벤트가 에러 없이 안 들어온다.
 *
 * 증상이 비대칭이라 알아채기 어렵다 — 발행은 매번 fresh 연결이라 계속 성공하고
 * 수신만 멈춘다. 실제로 "고객이 보낸 채팅이 어드민에 안 뜨는데 새로고침하면
 * 다 나오는" 현상으로 나타났다.
 *
 * 형제 프로젝트(cliprelay)에서 같은 원인을 길게 추적한 기록이 있다
 * (`cliprelay/PLAN-subscription-recovery.md`). 거기서 정리된 원인 중 이 앱에
 * 해당하는 것은 둘이다:
 *
 *   1. 발행/구독 pool 분리 → 발행 성공이 구독 생존을 보장하지 않는다
 *   2. 재연결 후 EOSE가 4.4초 안에 안 오면 그 릴레이의 이벤트가 조용히 무시된다
 *
 * 우선 라이브러리가 할 수 있는 복구부터 켠다. 지금은 그조차 꺼져 있었다.
 *
 * ── 여기서 멈추는 이유
 *
 * cliprelay는 헬스체크 4단 사다리(재구독 → 강제 재연결 → pool 파괴 → 페이지 리로드)까지
 * 갔지만, 그건 상시 켜두는 데스크탑/모바일 앱이라 이틀 방치와 OS suspend를 상대해야
 * 했기 때문이다. 이 앱은 브라우저 탭이고 `visibilitychange`마다 구독을 다시 만들며,
 * 채팅 구독은 상세 페이지를 열 때마다 새로 생긴다. 같은 무게의 장치를 미리 옮기면
 * 원인이 다른데 대응만 무거워지고, 무엇보다 여러 겹을 한 번에 넣으면 나중에
 * 무엇이 들었는지 알 수 없게 된다. 재발하면 그때 헬스체크를 얹는다.
 */
import { SimplePool } from 'nostr-tools/pool';

export function createSubscriptionPool(): SimplePool {
  return new SimplePool({ enablePing: true, enableReconnect: true });
}
