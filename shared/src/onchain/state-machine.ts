/**
 * 온체인 트랙 FSM (PLAN-ONCHAIN-TRACK §4)
 *
 * ── 왜 라이트닝 FSM과 합치지 않았나
 *
 * 세 가지가 구조적으로 다르다.
 *
 * **① 순서가 뒤집힌다.** 라이트닝은 후원자가 매칭된 *뒤* 고객이 에스크로를 건다.
 * 온체인은 주소가 세 키에 커밋하므로 **후원자를 알기 전에는 주소 자체가 없다**(§2.1).
 *
 * **② 어드민의 역할이 다르다.** 라이트닝에서 어드민은 자금을 들고 있는 수탁자다
 * (홀드 인보이스를 settle/cancel한다). 온체인에서는 **공동 서명자**일 뿐이고
 * `settle`·`cancel`에 해당하는 동작 자체가 없다.
 *
 * **③ 종결이 공짜가 아니다.** 라이트닝은 상태 발행 한 번이면 끝난다. 온체인은
 * 모든 종결에 tx 브로드캐스트와 컨펌이 필요하고 그 사이에 멤풀 이탈·RBF·리오그가
 * 있다. 그래서 "종결 직전" 상태(`settling`)가 필수다.
 *
 * 합치면 모든 핸들러가 `if (track === 'onchain')`로 갈라진다. FSM은 이 앱의 보안
 * 핵심이고 전이 하나하나가 공격 하나에 대응한다 — 가장 위험한 자리에 분기를
 * 심는 셈이다.
 */

export const ONCHAIN_STATES = {
  /** 의뢰 등록됨 (고객 LN 보증금 결제 완료). 오더북 노출 */
  LISTED: 'listed',
  /** 후원자 보증금 accepted = **클레임 성립**. 세 키 확정 → 에스크로 주소 발행 */
  BONDED: 'bonded',
  /** 고객 펀딩 tx가 멤풀에 있음 (컨펌 대기) */
  FUNDING: 'funding',
  /** 펀딩 N컨펌. **KRW 가격 확정(T0)**. 후원자의 주소+사전서명 대기 */
  FUNDED: 'funded',
  /** 후원자 사전서명 검증됨. 고객이 5분 내 계좌 공개 → 그때부터 원화 송금 창 30분 */
  PRESIGNED: 'presigned',
  /** 후원자가 원화 송금을 주장. 고객이 은행을 확인하고 cosign해야 한다 */
  REMITTED: 'remitted',
  /** 어드민 판정 대기. **고객 의사와 무관하게 진입한다**(O-010) */
  DISPUTED: 'disputed',
  /** 종결 tx 브로드캐스트됨 (멤풀). `settlementKind`가 어느 종결인지 지정 */
  SETTLING: 'settling',

  // ── 터미널 (전부 컨펌된 tx가 근거) ──
  /** `{C,S}` 릴리스 컨펌 — 정상 완료 */
  RELEASED: 'released',
  /** `{A,C}` 환불 컨펌 — 분쟁이 아닌 사유. **사유별로 보증금 처리가 다르다** */
  REFUNDED: 'refunded',
  /** `{A,S}` 컨펌 — 분쟁 판정 */
  SPONSOR_WINS: 'sponsor_wins',
  /** `{A,C}` 컨펌 — 분쟁 판정 (tx 모양은 refunded와 같고, 사유·보증금 처리가 다르다) */
  CUSTOMER_WINS: 'customer_wins',
  /** 펀딩 전 취소 — 온체인 tx 없음 */
  CANCELLED: 'cancelled',
  /** 타임락으로 고객이 일방 회수 (어드민 고장). 어드민은 **관측만** 한다 (O-006) */
  SWEPT: 'swept',
} as const;

export type OnchainState = typeof ONCHAIN_STATES[keyof typeof ONCHAIN_STATES];

/**
 * 허용된 전이.
 *
 * ```
 * listed → bonded → funding → funded → presigned → remitted → settling → released
 *                                                      └──→ disputed ──┘
 * ```
 *
 * 몇 군데가 직관과 다른데 전부 이유가 있다:
 *
 * - **`funding → bonded`** — 펀딩 tx가 RBF로 교체되거나 충돌 tx가 컨펌돼 **사라진**
 *   경우. 주문은 살아 있고 고객이 다시 쏘면 된다.
 * - **`funded|presigned → funding`** — 리오그로 컨펌이 N 아래로 내려간 경우.
 *   **가격 고정도 같이 폐기**된다(O-008). 안 그러면 사라진 펀딩 위에 가격만 남는다.
 * - **`presigned`에서 분쟁 진입이 없다** — 후원자의 "계좌를 못 쓴다"는 주장은
 *   상태가 아니라 **증거**다(§5.2b). 상태로 받으면 원화 마감 시계가 멈추고
 *   그 순간 무한 옵션이 열린다(§7.6 R4-H1).
 * - **`settling`은 되돌아가지 않는다**(O-005) — 멤풀 이탈은 **같은 tx 재브로드캐스트**로
 *   대응한다. 종결이 `remitted`로 돌아가는 전이는 의미가 없다.
 * - **`swept`으로 가는 화살표가 없다** — 어드민이 만드는 상태가 아니라 체인에서
 *   관측하는 결과다(O-006). 펀딩 컨펌 이후 어느 상태에서든 관측될 수 있다.
 */
export const ONCHAIN_TRANSITIONS: Record<OnchainState, readonly OnchainState[]> = {
  listed: ['bonded', 'cancelled'],
  bonded: ['funding', 'cancelled'],
  funding: ['funded', 'bonded', 'cancelled'],
  funded: ['presigned', 'settling', 'funding'],
  presigned: ['remitted', 'settling', 'funding'],
  remitted: ['settling', 'disputed'],
  disputed: ['settling'],
  settling: ['released', 'refunded', 'sponsor_wins', 'customer_wins'],

  released: [],
  refunded: [],
  sponsor_wins: [],
  customer_wins: [],
  cancelled: [],
  swept: [],
};

export function canOnchainTransition(from: OnchainState, to: OnchainState): boolean {
  return ONCHAIN_TRANSITIONS[from].includes(to);
}

/**
 * 터미널 목록은 **전이 맵에서 유도한다**(§10 재발방지 #4). 손으로 나열하면
 * 반드시 갈라진다 — 라이트닝 트랙에서 `TERMINAL_STATES`가 다섯 군데 복붙돼
 * 있다가 `admin_closed`를 추가할 때 둘만 고쳐져 종결된 의뢰가 오더북에 남았다.
 */
export const ONCHAIN_TERMINAL_STATES: ReadonlySet<OnchainState> = new Set(
  (Object.keys(ONCHAIN_TRANSITIONS) as OnchainState[])
    .filter(s => ONCHAIN_TRANSITIONS[s].length === 0),
);

export function isOnchainTerminal(state: OnchainState | undefined): boolean {
  return state !== undefined && ONCHAIN_TERMINAL_STATES.has(state);
}

// ────────────────────────────────────────────────────────────────────────
// 종결 사유 → 보증금 처리
// ────────────────────────────────────────────────────────────────────────

/**
 * `settling`을 거치는 종결의 사유 (§4.1).
 *
 * `settlementKind`를 상태에서 분리한 이유: `refunded` 하나에 **보증금 처리가
 * 정반대인 사례**가 섞여 있었다. 후원자가 버려서 환불한 것과, 시세가 reserve에
 * 못 미쳐 아무 과실 없이 환불한 것은 tx 모양이 같지만 돈 처리가 반대다.
 * **전이만 보고 판단하면 어드민이 정반대로 처리한다.**
 */
export const SETTLEMENT_KINDS = {
  RELEASE: 'release',
  /** 컨펌 시점 시세가 고객 reserve 미만 — 아무도 과실이 없다 */
  REFUND_RESERVE: 'refund:reserve',
  /** 후원자가 사전서명·원화송금 마감을 넘김 */
  REFUND_SPONSOR_TIMEOUT: 'refund:sponsor-timeout',
  /** 고객이 5분 내 계좌를 공개하지 않음 */
  REFUND_CUSTOMER_LATE: 'refund:customer-late',
  /** `funded` 진입 시 후원자 보증금이 이미 만료 (O-015) */
  REFUND_BOND_EXPIRED: 'refund:bond-expired',
  SPONSOR_WIN: 'sponsor_win',
  CUSTOMER_WIN: 'customer_win',
} as const;

export type SettlementKind = typeof SETTLEMENT_KINDS[keyof typeof SETTLEMENT_KINDS];

/**
 * tx 없이 끝나는 종결 + 어드민이 관여하지 않는 종결.
 * `settlementKind`가 아니라서 §4.1 표에 안 잡혀 있던 것들이다(§4.1b).
 */
export const NON_TX_OUTCOMES = {
  /** `listed → cancelled` — 고객이 스스로 접음 (후원자 없음) */
  CANCEL_BY_CUSTOMER: 'cancel:customer',
  /** `listed → cancelled` — 의뢰 만료 (후원자가 안 붙음) */
  CANCEL_EXPIRED: 'cancel:expired',
  /** `bonded → cancelled` — 고객이 6h 내 펀딩 안 함 */
  CANCEL_NO_FUNDING: 'cancel:no-funding',
  /** `funding → cancelled` — 펀딩 tx 부재가 확인됨 (O-014) */
  CANCEL_FUNDING_GONE: 'cancel:funding-gone',
  /** 타임락 회수 — 어드민이 죽어서 고객이 혼자 뺐다 */
  SWEPT: 'swept',
} as const;

export type NonTxOutcome = typeof NON_TX_OUTCOMES[keyof typeof NON_TX_OUTCOMES];
export type OnchainOutcome = SettlementKind | NonTxOutcome;

/**
 * 보증금의 운명.
 * - `refund`  — 어드민이 홀드 인보이스를 cancel한다 (라우팅 수수료 0)
 * - `forfeit` — 어드민이 settle한다 = **어드민이 갖는다**
 * - `expired` — 어드민이 손댈 게 없다. LN CLTV 만료로 이미/저절로 환불된다
 * - `none`    — 애초에 그 보증금이 없다 (후원자가 안 붙은 단계)
 */
export type BondDisposition = 'refund' | 'forfeit' | 'expired' | 'none';

export interface OutcomeRule {
  /** 이 사유로 끝났을 때 도달하는 터미널 상태 */
  terminal: OnchainState;
  sponsorBond: BondDisposition;
  customerBond: BondDisposition;
  /**
   * 어드민이 **판정 노동**을 한 종결인가.
   *
   * 몰수금의 쓰임을 가른다(§6.0): 분쟁이면 **전액 중재료**, 타임아웃이면
   * 50%를 피해자에게 수동 충당한다. 분쟁에 충당 정책을 적용하면 중재료가 안 남는다.
   */
  arbitrated: boolean;
  /** 어드민 화면에 그대로 뜨는 한 줄 */
  label: string;
}

/**
 * **사유가 곧 보증금 처리다.** 이 표가 §4.1 + §4.1b를 코드로 옮긴 것이고,
 * `Record`로 못박아 사유를 추가하면 **빌드가 깨지게** 했다.
 */
export const OUTCOME_RULES: Record<OnchainOutcome, OutcomeRule> = {
  'release': {
    terminal: 'released',
    sponsorBond: 'refund', customerBond: 'refund',
    arbitrated: false, label: '정상 완료',
  },
  'refund:reserve': {
    terminal: 'refunded',
    sponsorBond: 'refund', customerBond: 'refund',
    arbitrated: false, label: '시세가 최저가 미만 — 양쪽 무과실',
  },
  'refund:sponsor-timeout': {
    terminal: 'refunded',
    sponsorBond: 'forfeit', customerBond: 'refund',
    arbitrated: false, label: '후원자 마감 초과',
  },
  'refund:customer-late': {
    terminal: 'refunded',
    sponsorBond: 'refund', customerBond: 'forfeit',
    arbitrated: false, label: '고객이 계좌를 제때 공개하지 않음',
  },
  'refund:bond-expired': {
    // 후원자 보증금은 이미 LN 만료로 환불된 상태다. 어드민이 할 일이 없다.
    terminal: 'refunded',
    sponsorBond: 'expired', customerBond: 'refund',
    arbitrated: false, label: '후원자 보증금 만료 — 무담보 창을 열지 않고 접음',
  },
  'sponsor_win': {
    terminal: 'sponsor_wins',
    sponsorBond: 'refund', customerBond: 'forfeit',
    arbitrated: true, label: '분쟁 판정: 후원자 승',
  },
  'customer_win': {
    terminal: 'customer_wins',
    sponsorBond: 'forfeit', customerBond: 'refund',
    arbitrated: true, label: '분쟁 판정: 고객 승',
  },

  'cancel:customer': {
    terminal: 'cancelled',
    sponsorBond: 'none', customerBond: 'refund',
    arbitrated: false, label: '고객이 의뢰를 접음',
  },
  'cancel:expired': {
    terminal: 'cancelled',
    sponsorBond: 'none', customerBond: 'refund',
    arbitrated: false, label: '의뢰 만료 — 후원자가 붙지 않음',
  },
  'cancel:no-funding': {
    terminal: 'cancelled',
    sponsorBond: 'refund', customerBond: 'forfeit',
    arbitrated: false, label: '고객이 6시간 내 펀딩하지 않음',
  },
  'cancel:funding-gone': {
    // 펀딩 tx가 멤풀에도 없고 컨펌도 안 된 것이 확인된 경우에만 온다(O-014).
    // 자금이 움직이지 않았으므로 누구의 과실도 아니다.
    terminal: 'cancelled',
    sponsorBond: 'refund', customerBond: 'refund',
    arbitrated: false, label: '펀딩 tx 부재 확인 — 자금이 움직이지 않았다',
  },
  'swept': {
    // 어드민이 죽은 상황이라 홀드 인보이스를 settle도 cancel도 못 한다.
    // 양쪽 보증금은 CLTV 타임아웃으로 자동 환불된다 — 그게 맞는 결과다.
    terminal: 'swept',
    sponsorBond: 'expired', customerBond: 'expired',
    arbitrated: false, label: '타임락 회수 — 어드민 부재',
  },
};

/** 몰수금의 쓰임 (§6.0). 분쟁이면 중재료가 우선이고 피해자 충당은 안 한다. */
export function forfeitUse(outcome: OnchainOutcome): 'arbitration-fee' | 'compensation' | null {
  const rule = OUTCOME_RULES[outcome];
  if (rule.sponsorBond !== 'forfeit' && rule.customerBond !== 'forfeit') return null;
  return rule.arbitrated ? 'arbitration-fee' : 'compensation';
}

// ────────────────────────────────────────────────────────────────────────
// 불변조건 헬퍼 — 핸들러의 if가 아니라 여기서 막는다
// ────────────────────────────────────────────────────────────────────────

/**
 * **O-001 · O-014.** `bonded` 이후 `cancelled`로 가려면 **"주소에 컨펌 UTXO 없음 +
 * 펀딩 tx 멤풀에 없음"** 을 확인해야 한다.
 *
 * 멤풀 tx는 몇 시간 뒤에도 컨펌된다. "12시간 지났으니 취소"로 보내면 그 뒤
 * 펀딩이 컨펌됐을 때 **아무도 안 보는 2-of-3 주소에 자금이 갇힌다.**
 *
 * `chainSaysAbsent`가 `undefined`인 건 **"모른다"** 다(조회 실패). 모르면 막는다 —
 * 조회 실패를 '없음'으로 뭉개는 게 정확히 `FundStatus`에서 겪은 사고다.
 */
export function canCancelOnchain(
  from: OnchainState,
  chainSaysFundingAbsent?: boolean,
): boolean {
  if (!canOnchainTransition(from, 'cancelled')) return false;
  // listed 단계엔 주소 자체가 없다 — 확인할 대상이 없으므로 그냥 간다.
  if (from === 'listed') return true;
  return chainSaysFundingAbsent === true;
}

/**
 * **O-002 · O-003.** 계좌 정보를 발행해도 되는 상태인가.
 *
 * 라이트닝의 `canSendAccountInfo`와 **같은 자리**다. 거기서는 "후원자가 받을
 * 인보이스를 냈는가"가 관문이었고, 여기서는 **"후원자가 사전서명을 냈는가"** 다.
 * 후원자의 되돌릴 수 없는 행동(원화 이체)은 계좌번호를 본 직후에 일어나므로,
 * 그 전에는 계좌가 **릴레이에 존재하지도 않아야** 한다. 가리는 게 아니라
 * 발행하지 않는 것이다.
 *
 * `undefined`는 "아직 모른다"이고, 모르면 보내지 않는다.
 */
export function canSendAccountInfoOnchain(state: OnchainState | undefined): boolean {
  return state === 'presigned' || state === 'remitted';
}

/**
 * **O-007.** 릴리스는 **고객이 원화 수령을 확인해야만** 나간다.
 * `remitted` 이벤트는 후원자의 일방적 주장이므로 트리거가 아니다.
 *
 * 이 함수가 `false`를 돌려주는 건 "아직"이 아니라 **"절대 자동으로는 안 된다"** 다.
 * §9에서 어드민 동작을 대거 자동화하는데 그 흐름에 휩쓸려 cosign까지 자동화하기
 * 쉽다 — 그러면 후원자가 원화를 한 푼도 안 보내고 BTC를 가져간다(공격 Q).
 */
export function canAutoRelease(): false {
  return false;
}

/**
 * **O-016.** 고객 앱이 cosign해도 되는 가격 유효창인가.
 *
 * 후원자가 늦게 원화를 보내 **낡은 가격으로 체결**시키는 걸 막는다. 창 안이면
 * 프롬프트조차 안 뜨고(정직한 거래에 마찰 0), 넘기면 경고 후 **명시적 우회만**
 * 허용한다. 값이 `remitted` cosign 마감과 같아서 노브가 하나 더 늘지 않는다.
 */
export const PRICE_VALIDITY_MS = 24 * 60 * 60 * 1000;

export function isPriceStale(remittedAtMs: number, nowMs: number): boolean {
  return nowMs - remittedAtMs > PRICE_VALIDITY_MS;
}
