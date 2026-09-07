/**
 * 구독 생명주기 가드
 *
 * 구독 시작은 비동기다(릴레이 목록·키 조회). 그 대기 구간 동안 cleanup 핸들이
 * 아직 null이라, 단순한 `if (cleanup) return` 가드는 중복 진입을 막지 못한다.
 * 모바일에서 로드 직후 visibilitychange가 뜨면 실제로 이 창이 열린다:
 *
 *   1. 마운트가 start()를 부른다 → await 지점에서 멈춤 (cleanup 아직 null)
 *   2. visibilitychange가 stop() → 닫을 핸들이 없어 아무것도 안 닫힘
 *   3. 이어서 start() → 가드가 null을 보고 통과 → 두 번째 구독 세트 생성
 *   4. 1번이 뒤늦게 깨어나 핸들 할당 → 2번이 그 위를 덮음
 *
 * 결과: 소켓 구독은 2벌인데 앱은 1벌만 안다. 앞의 1벌은 영영 안 닫히고,
 * 리로드/포그라운드 복귀를 반복할수록 유령 구독이 쌓인다.
 *
 * 가드는 두 가지로 이를 막는다:
 * - `starting`: 진행 중인 시작 작업을 붙들어 대기 구간까지 중복 진입을 덮는다.
 * - `generation`: stop이 끼어들면 세대를 올려, 뒤늦게 끝난 start가 자기 구독을
 *   스스로 닫게 한다(누수 방지).
 */
export interface SubscriptionGuard {
  /**
   * `factory`가 구독을 만들고 그 전체를 닫는 cleanup 하나를 돌려준다.
   * 이미 살아있거나 시작 중이면 새로 만들지 않는다.
   */
  start(factory: () => Promise<() => void>): Promise<void>;
  /** 살아있는 구독을 닫고, 진행 중인 시작 작업을 무효화한다. */
  stop(): void;
  /** 현재 구독이 살아있는지 */
  readonly active: boolean;
}

export function createSubscriptionGuard(label: string): SubscriptionGuard {
  let cleanup: (() => void) | null = null;
  let starting: Promise<void> | null = null;
  let generation = 0;

  return {
    start(factory) {
      if (cleanup) return Promise.resolve();
      if (starting) return starting;

      const myGeneration = generation;

      const pending: Promise<void> = factory()
        .then((newCleanup) => {
          // 대기하는 동안 stop이 끼어들었으면 방금 만든 구독은 유령이다.
          if (myGeneration !== generation) {
            newCleanup();
            return;
          }
          cleanup = newCleanup;
        })
        .catch((err: unknown) => {
          console.error(`[${label}] 구독 시작 실패:`, err);
        })
        .finally(() => {
          // 내 차례가 아직 유효할 때만 해제한다.
          // stop 이후 새 start가 들어왔다면 그쪽 것을 건드리면 안 된다.
          if (starting === pending) starting = null;
        });

      starting = pending;
      return pending;
    },

    stop() {
      generation++; // 진행 중인 start를 무효화
      // 진행 중이던 시작을 놓아준다. 붙들고 있으면 곧바로 이어지는 재시작이
      // 그 죽은 Promise를 돌려받고 새 구독을 아예 만들지 않는다.
      starting = null;
      cleanup?.();
      cleanup = null;
    },

    get active() {
      return cleanup !== null;
    },
  };
}
