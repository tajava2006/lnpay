/**
 * 키 단위 재진입 가드
 *
 * "검사 → await → 기록" 모양의 코드는 await 구간이 열려 있다. 같은 키로 두 번
 * 들어오면 둘 다 검사를 통과해 부수효과가 두 번 일어난다. 돈이 걸린 경로에서는
 * 외부 시스템(예: LND의 payment hash 중복 거르기)이 막아주길 기대하면 안 된다 —
 * 그건 우리 보증이 아니다.
 *
 * 구독 가드(subscription-guard)가 푸는 것과 같은 문제이지만, 이쪽은 대상이
 * 하나가 아니라 키별로 여럿이고 "합류"가 아니라 "거절"이 맞다 — 두 번째 호출자에게
 * 성공을 돌려주면 하지도 않은 일을 했다고 보고하는 셈이 된다.
 */
export interface SingleFlight {
  /**
   * `key`가 진행 중이 아니면 `fn`을 실행한다.
   * 이미 진행 중이면 `fn`을 부르지 않고 `onBusy()`를 돌려준다.
   */
  run<T>(key: string, fn: () => Promise<T>, onBusy: () => T): Promise<T>;
  /** 해당 키가 진행 중인지 */
  isBusy(key: string): boolean;
}

export function createSingleFlight(): SingleFlight {
  const inFlight = new Set<string>();

  return {
    async run(key, fn, onBusy) {
      if (inFlight.has(key)) return onBusy();

      inFlight.add(key);
      try {
        return await fn();
      } finally {
        // fn이 던져도 반드시 풀어준다. 안 그러면 한 번 실패한 키가 영구히 잠긴다.
        inFlight.delete(key);
      }
    },

    isBusy(key) {
      return inFlight.has(key);
    },
  };
}
