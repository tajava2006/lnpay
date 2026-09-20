/**
 * 온체인 FSM 전이 + 불변조건 (PLAN-ONCHAIN-TRACK §4.2)
 *
 * 라이트닝 FSM 테스트(`admin/src/tests/state-machine.test.ts`)와 **같은 구조**로
 * 짰다 — 두 트랙을 나란히 놓고 리뷰할 수 있어야 한다.
 *
 * 여기 있는 항목 하나하나가 §7 공격 표의 한 줄에 대응한다. 전이 맵이 느슨해지면
 * 그 공격이 다시 열린다는 뜻이다.
 */
import { describe, it, expect } from 'vitest';
import {
  ONCHAIN_STATES,
  ONCHAIN_TERMINAL_STATES,
  ONCHAIN_TRANSITIONS,
  OUTCOME_RULES,
  PRICE_VALIDITY_MS,
  SETTLEMENT_KINDS,
  canAutoRelease,
  canCancelOnchain,
  canOnchainTransition,
  canSendAccountInfoOnchain,
  forfeitUse,
  isOnchainTerminal,
  isPriceStale,
  type OnchainOutcome,
  type OnchainState,
} from '../onchain/state-machine';

const ALL = Object.values(ONCHAIN_STATES);

describe('전이표 정합', () => {
  it('모든 상태가 키로 있고, 목적지도 전부 알려진 상태다', () => {
    const keys = Object.keys(ONCHAIN_TRANSITIONS).sort();
    expect(keys).toEqual([...ALL].sort());
    for (const from of ALL) {
      for (const to of ONCHAIN_TRANSITIONS[from]) {
        expect(ALL).toContain(to);
      }
    }
  });

  it('자기 자신으로 가는 전이는 없다', () => {
    for (const from of ALL) {
      expect(ONCHAIN_TRANSITIONS[from]).not.toContain(from);
    }
  });
});

describe('정상 경로', () => {
  it.each([
    ['listed', 'bonded'],
    ['bonded', 'funding'],
    ['funding', 'funded'],
    ['funded', 'presigned'],
    ['presigned', 'remitted'],
    ['remitted', 'settling'],
    ['settling', 'released'],
  ] as const)('%s → %s', (from, to) => {
    expect(canOnchainTransition(from, to)).toBe(true);
  });
});

describe('순서 건너뛰기 차단', () => {
  /** 후원자를 모르면 주소 자체가 없다(§2.1). 펀딩이 클레임을 앞지를 수 없다. */
  it('listed → funding·funded 불가', () => {
    expect(canOnchainTransition('listed', 'funding')).toBe(false);
    expect(canOnchainTransition('listed', 'funded')).toBe(false);
  });

  /** 공격 D — 0-conf 펀딩 위에 가격을 고정하면 RBF로 되돌릴 수 있다. */
  it('bonded → funded 불가 (컨펌 없이 가격 고정 금지)', () => {
    expect(canOnchainTransition('bonded', 'funded')).toBe(false);
  });

  /** O-003 — 사전서명 없이 계좌가 나가면 후원자가 계좌만 받고 튄다. */
  it('funded → remitted 불가 (사전서명 없이 송금 주장 금지)', () => {
    expect(canOnchainTransition('funded', 'remitted')).toBe(false);
  });

  /** O-004 — 모든 터미널은 컨펌된 txid가 근거다. settling을 건너뛸 수 없다. */
  it.each(['released', 'refunded', 'sponsor_wins', 'customer_wins'] as const)(
    'presigned → %s 불가 (종결 tx 없이 종결 금지)',
    to => { expect(canOnchainTransition('presigned', to)).toBe(false); },
  );
});

describe('O-001 · O-014 — 자금이 확정된 뒤에는 tx 없이 취소할 수 없다', () => {
  it('funded 이후로는 cancelled 전이가 아예 없다', () => {
    for (const from of ['funded', 'presigned', 'remitted', 'disputed', 'settling'] as const) {
      expect(canOnchainTransition(from, 'cancelled')).toBe(false);
    }
  });

  it('listed에서는 확인 없이 취소된다 (주소가 아직 없다)', () => {
    expect(canCancelOnchain('listed')).toBe(true);
  });

  /**
   * 멤풀 tx는 몇 시간 뒤에도 컨펌된다. "시간이 지났으니 취소"로 보내면 그 뒤
   * 펀딩이 컨펌됐을 때 **아무도 안 보는 주소에 자금이 갇힌다.**
   */
  it('bonded·funding에서는 펀딩 부재가 확인돼야만 취소된다', () => {
    for (const from of ['bonded', 'funding'] as const) {
      expect(canCancelOnchain(from, true)).toBe(true);
      expect(canCancelOnchain(from, false)).toBe(false);
    }
  });

  /**
   * ⚠️ 이 인자는 **주소 기준**이어야 한다. 고객이 수수료를 올리면(RBF) txid가
   * 바뀌는데, txid를 쫓으면 "사라졌다"로 보인다. 그대로 취소하면 정직한 고객의
   * 보증금을 몰수하고 곧 컨펌될 자금을 버려진 주소로 보내는 셈이 된다.
   * 교체본도 같은 주소로 가므로 주소로 보면 안 놓친다. (P2 체인 어댑터 계약)
   */
  it('판정 기준은 "이 주소가 아직 비었는가"다', () => {
    // 같은 주소로 가는 교체 tx가 멤풀에 있으면 = 비지 않았다 = 취소 불가
    expect(canCancelOnchain('funding', false)).toBe(false);
  });

  /** 조회 실패를 '없음'으로 뭉개면 위험한 판단을 부른다 (`FundStatus`에서 겪은 것). */
  it('체인 조회 결과를 모르면(undefined) 취소하지 않는다', () => {
    expect(canCancelOnchain('funding', undefined)).toBe(false);
    expect(canCancelOnchain('bonded')).toBe(false);
  });
});

describe('O-005 — settling은 되돌아가지 않는다', () => {
  it('종결 넷으로만 나간다', () => {
    expect([...ONCHAIN_TRANSITIONS.settling].sort())
      .toEqual(['customer_wins', 'refunded', 'released', 'sponsor_wins']);
  });

  it.each(['remitted', 'disputed', 'presigned', 'funded', 'funding'] as const)(
    'settling → %s 불가 (멤풀 이탈은 재브로드캐스트로 대응한다)',
    to => { expect(canOnchainTransition('settling', to)).toBe(false); },
  );
});

describe('O-006 — swept은 관측이지 전이가 아니다', () => {
  it('어떤 상태에서도 swept으로 가는 화살표가 없다', () => {
    for (const from of ALL) {
      expect(canOnchainTransition(from, 'swept')).toBe(false);
    }
  });

  it('그래도 터미널이다 (나가는 전이가 없다)', () => {
    expect(isOnchainTerminal('swept')).toBe(true);
  });
});

describe('O-008 — 리오그 복귀', () => {
  it('funded·presigned에서 funding으로 돌아갈 수 있다', () => {
    expect(canOnchainTransition('funded', 'funding')).toBe(true);
    expect(canOnchainTransition('presigned', 'funding')).toBe(true);
  });

  it('펀딩 tx가 사라지면 bonded로 돌아간다', () => {
    expect(canOnchainTransition('funding', 'bonded')).toBe(true);
  });
});

describe('§7.6 — presigned에서 분쟁으로 못 간다', () => {
  /**
   * 후원자의 "계좌를 못 쓴다"를 상태로 받으면 원화 마감 시계가 멈추고,
   * 그 순간 **최장 8주짜리 무한 옵션**이 열린다(R4-H1). 이의는 증거로만 붙는다.
   */
  it('presigned → disputed 불가', () => {
    expect(canOnchainTransition('presigned', 'disputed')).toBe(false);
  });

  it('분쟁은 remitted에서만 열린다', () => {
    expect(canOnchainTransition('remitted', 'disputed')).toBe(true);
    for (const from of ['listed', 'bonded', 'funding', 'funded'] as const) {
      expect(canOnchainTransition(from, 'disputed')).toBe(false);
    }
  });

  /** O-011 — 분쟁에서 한쪽이 단독으로 빠져나갈 수 없다. 출구는 종결 tx뿐. */
  it('disputed의 출구는 settling 하나뿐', () => {
    expect(ONCHAIN_TRANSITIONS.disputed).toEqual(['settling']);
  });
});

describe('터미널은 전이 맵에서 유도한다 (§10 재발방지 #4)', () => {
  it('나가는 전이가 없는 상태 = 터미널', () => {
    const derived = ALL.filter(s => ONCHAIN_TRANSITIONS[s].length === 0).sort();
    expect([...ONCHAIN_TERMINAL_STATES].sort()).toEqual(derived);
  });

  it('여섯 개다', () => {
    expect([...ONCHAIN_TERMINAL_STATES].sort()).toEqual(
      ['cancelled', 'customer_wins', 'refunded', 'released', 'sponsor_wins', 'swept'],
    );
  });

  it('비터미널은 전부 나갈 길이 있다 (막다른 골목 금지)', () => {
    for (const s of ALL) {
      if (!ONCHAIN_TERMINAL_STATES.has(s)) expect(ONCHAIN_TRANSITIONS[s].length).toBeGreaterThan(0);
    }
  });
});

describe('O-002 · O-003 — 계좌 정보 게이트', () => {
  it('presigned·remitted에서만 발행한다', () => {
    const allowed = ALL.filter(s => canSendAccountInfoOnchain(s));
    expect(allowed.sort()).toEqual(['presigned', 'remitted']);
  });

  it('모르면(undefined) 보내지 않는다', () => {
    expect(canSendAccountInfoOnchain(undefined)).toBe(false);
  });
});

describe('O-007 — 릴리스 자동화 금지 (공격 Q)', () => {
  /**
   * `remitted`는 후원자의 **일방적 주장**이다. 릴리스가 그 이벤트에 자동 반응하면
   * 후원자는 원화를 한 푼도 안 보내고 BTC를 가져간다. 타입까지 `false`로 못박아
   * "언젠가 조건부로 true를 돌려주자"는 수정이 들어올 자리를 없앴다.
   */
  it('언제나 false다', () => {
    expect(canAutoRelease()).toBe(false);
  });
});

describe('O-016 — 낡은 가격 (§7.6 ③)', () => {
  const t0 = 1_700_000_000_000;

  it('가격 유효창은 remitted + 24시간', () => {
    expect(PRICE_VALIDITY_MS).toBe(24 * 60 * 60 * 1000);
    expect(isPriceStale(t0, t0 + PRICE_VALIDITY_MS)).toBe(false);
    expect(isPriceStale(t0, t0 + PRICE_VALIDITY_MS + 1)).toBe(true);
  });

  it('정상 흐름(24시간 안)에는 우회 프롬프트가 안 뜬다', () => {
    expect(isPriceStale(t0, t0 + 60_000)).toBe(false);
  });
});

describe('사유 → 보증금 처리 (§4.1 · §4.1b)', () => {
  const OUTCOMES = Object.keys(OUTCOME_RULES) as OnchainOutcome[];

  it('모든 사유가 실제 터미널 상태로 끝난다', () => {
    for (const o of OUTCOMES) {
      expect(ONCHAIN_TERMINAL_STATES.has(OUTCOME_RULES[o].terminal)).toBe(true);
    }
  });

  /** settling을 거치는 사유는 그 터미널이 settling의 목적지에 실제로 있어야 한다. */
  it('settlementKind의 터미널은 settling에서 도달 가능하다', () => {
    for (const kind of Object.values(SETTLEMENT_KINDS)) {
      expect(canOnchainTransition('settling', OUTCOME_RULES[kind].terminal)).toBe(true);
    }
  });

  /**
   * ⚠️ 이 표가 §4.1과 어긋나면 **어드민이 돈을 정반대로 처리한다.**
   * 전이만 보고 판단할 수 없는 자리라 표 자체를 전수로 박는다.
   */
  it.each([
    ['release',                 'refund',  'refund'],
    ['refund:reserve',          'refund',  'refund'],
    ['refund:sponsor-timeout',  'forfeit', 'refund'],
    ['refund:customer-late',    'refund',  'forfeit'],
    ['refund:bond-expired',     'expired', 'refund'],
    ['sponsor_win',             'refund',  'forfeit'],
    ['customer_win',            'forfeit', 'refund'],
    ['cancel:customer',         'none',    'refund'],
    ['cancel:expired',          'none',    'refund'],
    ['cancel:no-funding',       'refund',  'forfeit'],
    ['cancel:funding-gone',     'refund',  'forfeit'],
    ['swept',                   'expired', 'expired'],
  ] as const)('%s → 후원자 %s / 고객 %s', (outcome, sponsor, customer) => {
    expect(OUTCOME_RULES[outcome].sponsorBond).toBe(sponsor);
    expect(OUTCOME_RULES[outcome].customerBond).toBe(customer);
  });

  it('양쪽을 동시에 몰수하지 않는다', () => {
    for (const o of OUTCOMES) {
      const r = OUTCOME_RULES[o];
      expect(r.sponsorBond === 'forfeit' && r.customerBond === 'forfeit').toBe(false);
    }
  });

  /**
   * 어드민 노동이 들어간 종결(분쟁)은 몰수금이 **전액 중재료**다. 타임아웃은
   * 노동이 없으므로 50% 피해자 충당 대상이 된다(§6.0). 섞이면 중재료가 안 남는다.
   */
  it('분쟁은 중재료, 타임아웃은 충당', () => {
    expect(forfeitUse('sponsor_win')).toBe('arbitration-fee');
    expect(forfeitUse('customer_win')).toBe('arbitration-fee');
    expect(forfeitUse('refund:sponsor-timeout')).toBe('compensation');
    expect(forfeitUse('cancel:no-funding')).toBe('compensation');
  });

  /**
   * `funding`에 들어갔다는 건 고객이 쏜 tx가 멤풀에 있었다는 뜻이고, 그 입력을
   * 통제하는 건 고객뿐이다. 사라졌다면 고객이 되돌린 것이다 — **후원자를
   * 기다리게 만든 뒤 빼간 것**이라 아예 안 쏜 것보다 나쁘다.
   */
  it('펀딩을 되돌린 것도 몰수다 (안 쏜 것보다 나쁘다)', () => {
    expect(OUTCOME_RULES['cancel:funding-gone'].customerBond).toBe('forfeit');
    expect(OUTCOME_RULES['cancel:no-funding'].customerBond).toBe('forfeit');
    // 다만 사유는 갈라 둔다 — "안 왔다"와 "왔다가 뺐다"는 다른 사건이다
    expect(OUTCOME_RULES['cancel:funding-gone'].label)
      .not.toBe(OUTCOME_RULES['cancel:no-funding'].label);
  });

  it('몰수가 없으면 쓸 곳도 없다', () => {
    expect(forfeitUse('release')).toBeNull();
    expect(forfeitUse('refund:reserve')).toBeNull();
    expect(forfeitUse('swept')).toBeNull();
  });

  it('분쟁 판정만 arbitrated다', () => {
    const arbitrated = OUTCOMES.filter(o => OUTCOME_RULES[o].arbitrated).sort();
    expect(arbitrated).toEqual(['customer_win', 'sponsor_win']);
  });

  /** 어드민이 죽은 종결에서는 어드민이 보증금을 손댈 수 없다 — LN 만료가 처리한다. */
  it('swept은 양쪽 다 LN 만료 환불이다', () => {
    expect(OUTCOME_RULES.swept.sponsorBond).toBe('expired');
    expect(OUTCOME_RULES.swept.customerBond).toBe('expired');
  });
});

describe('타입 경계', () => {
  it('상태 상수와 문자열 리터럴이 일치한다', () => {
    const states: OnchainState[] = [...ALL];
    expect(states).toHaveLength(14);
  });
});
