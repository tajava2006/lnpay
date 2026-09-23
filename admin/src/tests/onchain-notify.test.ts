/**
 * 온체인 알림 문구 전수 (PLAN-ONCHAIN-TRACK §10 재발방지 #2)
 *
 * **FSM을 고치면 다섯이 세트다**: 전이 맵 → 알림 문구 → 문서 → 진행도 → 배지.
 * 라이트닝에서 `invoiced`를 추가하며 이 표를 빠뜨려, 거래가 실제로 멈추는
 * 단계에 알림이 없었다(2026-09-19). 여기서는 전수로 돈다.
 */
import { describe, it, expect } from 'vitest';
import {
  ONCHAIN_PROGRESS_STEPS, ONCHAIN_STATES, onchainStepActor,
  type OnchainState,
} from '@sajwo-tracker/shared/onchain';
import {
  ONCHAIN_NOTIFY, ONCHAIN_TIMER_NOTICES, ONCHAIN_TRANSITION_NOTICES,
} from '../onchain/notify-messages';
import { asDirectMessage, asPush } from '../nostr/notify-messages';

const ALL = Object.values(ONCHAIN_STATES);

describe('표가 상태를 전부 덮는다', () => {
  it('모든 상태가 키로 있다', () => {
    expect(Object.keys(ONCHAIN_TRANSITION_NOTICES).sort()).toEqual([...ALL].sort());
  });

  /** `null`은 "빠뜨렸다"가 아니라 "보낼 게 없다"를 명시한 것이다. */
  it('알림이 없는 상태는 셋뿐이고, 각각 이유가 있다', () => {
    const silent = ALL.filter(s => ONCHAIN_TRANSITION_NOTICES[s] === null).sort();
    expect(silent).toEqual(['listed', 'settling', 'swept']);
  });
});

describe('움직여야 하는 쪽에게 알림이 간다', () => {
  /**
   * 진행도 사다리가 "이 단계는 누구 차례"라고 말하면, 그 사람에게 알림이
   * 있어야 한다. 두 표가 갈라지면 **거래가 멈추는 자리에 알림이 없는** 상태가 된다.
   *
   * `listed`는 제외한다 — 후원자가 아직 **특정되지 않아** 보낼 대상이 없다.
   * 거기서는 오더북 자체가 알림 역할을 한다.
   */
  it.each(
    ONCHAIN_PROGRESS_STEPS
      .map(s => s.state)
      .filter(s => s !== 'listed')
      .map(s => [s, onchainStepActor(s)] as const)
      .filter(([, actor]) => actor === 'customer' || actor === 'sponsor'),
  )('%s 단계의 주체(%s)에게 알림이 있다', (state, actor) => {
    const notices = ONCHAIN_TRANSITION_NOTICES[state];
    expect(notices, state).not.toBeNull();
    expect(notices?.[actor as 'customer' | 'sponsor'], `${state}/${actor}`).toBeDefined();
  });

  it('remitted는 고객에게 간다 — 상대는 이미 돈을 보내놓고 기다린다', () => {
    expect(ONCHAIN_TRANSITION_NOTICES.remitted?.customer?.body).toMatch(/입금을 확인/);
  });

  it('funded는 후원자에게 간다 — 앱이 깨어 있어야 지나가는 구간이다', () => {
    expect(ONCHAIN_TRANSITION_NOTICES.funded?.sponsor?.body).toMatch(/15분/);
  });
});

describe('종결은 양쪽에 알린다', () => {
  it.each(['released', 'refunded', 'sponsor_wins', 'customer_wins', 'cancelled'] as const)(
    '%s',
    state => {
      const n = ONCHAIN_TRANSITION_NOTICES[state];
      expect(n?.customer, state).toBeDefined();
      expect(n?.sponsor, state).toBeDefined();
    },
  );

  it('분쟁 결과는 승패에 따라 문구가 갈린다', () => {
    expect(ONCHAIN_TRANSITION_NOTICES.sponsor_wins?.sponsor?.body)
      .not.toBe(ONCHAIN_TRANSITION_NOTICES.sponsor_wins?.customer?.body);
  });

  /** 충당은 운영 재량이다. "보상받습니다"를 띄우면 그 순간 권리가 된다(§6.0). */
  it('환불 알림이 보상을 약속하지 않는다', () => {
    const body = ONCHAIN_TRANSITION_NOTICES.refunded?.customer?.body ?? '';
    expect(body).not.toMatch(/보상|보전|돌려드립니다/);
  });
});

describe('마감이 부르는 알림', () => {
  it('넷이 전이표 밖에 있다', () => {
    expect(Object.keys(ONCHAIN_TIMER_NOTICES).sort())
      .toEqual(['accountInfoArrived', 'disputeSoon', 'rulingDecided', 'rulingSignatureNeeded']);
  });

  /** 계좌 도착은 상태가 안 바뀐다 — 그런데 후원자가 움직일 수 있게 되는 순간이다. */
  it('계좌 도착 알림이 30분 창을 말해준다', () => {
    expect(ONCHAIN_TIMER_NOTICES.accountInfoArrived().body).toMatch(/30분/);
  });

  /** 느린 고객 대부분이 유예 경고에서 스스로 끝낸다 → 어드민이 안 불려 나온다. */
  it('분쟁 임박 경고가 있다', () => {
    expect(ONCHAIN_TIMER_NOTICES.disputeSoon().body).toMatch(/분쟁/);
  });

  /**
   * 환불도 고객 서명이 필요하다 — 안 오면 자기 돈이 잠긴 채로 남는다.
   * 리뷰 #8 전에는 이 문구가 타이머 표에만 있고 **부르는 곳이 없어** 한 번도 안 나갔다.
   * 이제 `refunding` **전이** 알림이라 상태가 바뀌면 반드시 나간다.
   */
  it('환불 결정은 고객에게 서명을, 후원자에게 "보내지 말라"를 알린다', () => {
    expect(ONCHAIN_TRANSITION_NOTICES.refunding?.customer?.body).toMatch(/서명/);
    expect(ONCHAIN_TRANSITION_NOTICES.refunding?.sponsor?.body).toMatch(/보내지 마세요/);
  });

  it('분쟁 판정은 이긴 쪽에게 서명을 요청한다', () => {
    expect(ONCHAIN_TIMER_NOTICES.rulingSignatureNeeded().body).toMatch(/서명/);
  });
});

describe('문구 정책', () => {
  const every = (): string[] => {
    const out: string[] = [];
    for (const s of ALL) {
      const n = ONCHAIN_TRANSITION_NOTICES[s];
      if (n?.customer) out.push(n.customer.body);
      if (n?.sponsor) out.push(n.sponsor.body);
    }
    for (const make of Object.values(ONCHAIN_TIMER_NOTICES)) out.push(make().body);
    return out;
  };

  it('전부 한국어이고 비어 있지 않다', () => {
    for (const body of every()) {
      expect(body.length).toBeGreaterThan(0);
      expect(body).toMatch(/[가-힣]/);
    }
  });

  /**
   * 알림 내용은 암호화되지만 **어디서 열어보는지는 우리가 모른다** — 잠금화면에
   * 그대로 뜰 수 있다. 금액·계좌·상대 신원은 넣지 않는다.
   */
  it('금액·계좌·신원을 담지 않는다', () => {
    for (const body of every()) {
      expect(body).not.toMatch(/sat|sats|₩|원화 \d|계좌번호|예금주|npub/i);
    }
  });

  /**
   * 온체인은 행동도 결과도 전부 `내 거래`에서 처리된다 — 오더북은 남의 의뢰를
   * 고르는 자리일 뿐이라 알림이 갈 곳이 아니다.
   */
  it('전부 온체인 트랙의 내 거래로 보낸다', () => {
    for (const notice of [
      ONCHAIN_NOTIFY.customerShouldFund(),
      ONCHAIN_NOTIFY.sponsorShouldRemit(),
      ONCHAIN_NOTIFY.released('customer'),
      ONCHAIN_NOTIFY.cancelled(),
    ]) {
      expect(notice.tab).toBe('history');
      expect(notice.track).toBe('onchain');
    }
  });
});

describe('통로 형식은 라이트닝과 공유한다', () => {
  it('푸시 URL이 온체인 트랙을 가리킨다', () => {
    expect(asPush(ONCHAIN_NOTIFY.customerShouldFund()).url)
      .toBe('/?track=onchain&tab=history');
  });

  it('DM에는 링크가 글로 붙는다', () => {
    const dm = asDirectMessage(ONCHAIN_NOTIFY.customerShouldFund());
    expect(dm).toMatch(/^\[페어바이\] /);
    expect(dm).toMatch(/\?track=onchain&tab=history$/);
  });

  it('푸시 태그로 주문별 묶음이 된다', () => {
    expect(asPush(ONCHAIN_NOTIFY.customerShouldConfirm(), 'order-1').tag).toBe('order-1');
  });
});

describe('사다리 밖 상태', () => {
  it('disputed는 양쪽에 알린다 (사다리에 없지만 사람이 움직여야 한다)', () => {
    const n = ONCHAIN_TRANSITION_NOTICES.disputed;
    expect(n?.customer).toBeDefined();
    expect(n?.sponsor).toBeDefined();
  });

  /**
   * `swept`은 **어드민이 죽어야** 일어난다. 그 상황에서는 이 코드가 아예 안 도므로
   * 알림을 정의해봐야 거짓말이다.
   */
  it('swept에는 알림이 없다', () => {
    expect(ONCHAIN_TRANSITION_NOTICES.swept).toBeNull();
  });

  it('타입이 상태 집합과 묶여 있다', () => {
    const states: OnchainState[] = [...ALL];
    expect(states).toHaveLength(14);
  });
});
