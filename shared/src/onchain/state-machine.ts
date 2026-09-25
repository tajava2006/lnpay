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
  /**
   * 후원자 보증금 accepted = **클레임 성립**. 세 키 확정 → 에스크로 주소 발행.
   * 고객이 마감 안에 펀딩을 **컨펌시켜야** 하는 구간이기도 하다.
   */
  BONDED: 'bonded',
  /** 펀딩 N컨펌. **KRW 가격 확정(T0)**. 후원자의 주소+사전서명 대기 */
  FUNDED: 'funded',
  /** 후원자 사전서명 검증됨. 고객이 15분 내 계좌 공개 → 그때부터 원화 송금 창 30분 */
  PRESIGNED: 'presigned',
  /** 후원자가 원화 송금을 주장. 고객이 은행을 확인하고 cosign해야 한다 */
  REMITTED: 'remitted',
  /** 어드민 판정 대기. **고객 의사와 무관하게 진입한다**(O-010) */
  DISPUTED: 'disputed',
  /**
   * **환불이 결정됐다.** 마감 초과·reserve 미달·보증금 만료로 거래가 끝났고,
   * 고객의 환불 서명을 기다린다. 체인에는 아직 아무 일도 없다.
   *
   * 상태로 둔 이유(리뷰 #8): 사이드 스토어였을 때는 상태가 `funded`/`presigned`에
   * 머물러 **늦은 사전서명·늦은 계좌·늦은 송금 주장을 그대로 받아줬다.** 그 사이
   * 고객은 환불 PSBT를 쥐고 있었으므로 원화를 받은 뒤 환불로 빠져나갈 수 있었다.
   * 결정을 상태로 박아야 앞으로 가는 전이를 전부 닫을 수 있다.
   */
  REFUNDING: 'refunding',
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
 * listed → bonded → funded → presigned → remitted → settling → released
 *             │        │          │           └──→ disputed ──┤
 *             └────────┴──────────┴──→ refunding ─────────────┘→ refunded
 * ```
 *
 * ── ⚠️ `funding` 상태는 **의도적으로 없다** (P2 착수 전 결정)
 *
 * v11까지 "펀딩 tx가 멤풀에 있음" 상태가 있었다. 지웠다. 이유:
 *
 * **① 그 상태의 정보 내용은 "0-conf를 봤다" 하나뿐인데, 우리는 0-conf로 아무
 * 결정도 내리지 않는다**(공격 D — 그래서 `funded`는 N컨펌 필수다). 아무 결정도
 * 안 내리는 상태를 FSM에 들고 있으면 전이·알림·배지·진행도만 늘어난다.
 *
 * **② 펀딩 판정은 오직 "마감 안에 이 주소로 약정 금액이 N컨펌 됐는가"다.**
 * 그 사이 고객이 멤풀에 넣었다 뺐다 하든, RBF로 수수료를 올리든, 아예 자기
 * 주소로 빼가든 **우리가 볼 이유가 없다.** 되돌린 것도 결국 "마감 안에 못
 * 맞췄다"로 같은 결론이고, 수수료를 낮게 잡아 못 맞춘 건 고객 책임이다.
 *
 * **③ txid를 쫓으면 오히려 틀린다.** 고객이 수수료를 올리면 txid가 바뀌는데,
 * 그걸 "사라졌다"로 읽으면 **정직한 고객의 보증금을 몰수**하게 된다.
 * txid가 필요한 건 그 UTXO를 **소모할 때**뿐이고, 그때는 컨펌된 UTXO에서 나온다.
 *
 * 멤풀 관측은 **화면 힌트로만** 남긴다("멤풀에서 보임 · 컨펌 대기") — 후원자
 * 불안을 덜어주는 값은 그대로고 FSM은 안 건드린다.
 *
 * ── 나머지 전이의 이유
 *
 * - **`funded|presigned → bonded`** — 리오그로 컨펌이 N 아래로 내려간 경우.
 *   **가격 고정도 같이 폐기**된다(O-008). 안 그러면 사라진 펀딩 위에 가격만 남는다.
 *   돌아가면서 **마감 시각을 다시 찍는다** — 안 그러면 체인 사고로 정직한 고객이
 *   몰수당한다. (양성 리오그면 같은 tx가 다시 캐져 outpoint도 그대로라, 후원자
 *   앱이 자동으로 다시 서명하면 그만이다.)
 * - **`bonded|funded|presigned → refunding`** — 환불이 **결정**됐다. `bonded`에서
 *   바로 가는 건 가격을 고정하지 않고 접는 경우다(reserve 미달 · O-015 보증금 만료).
 *   결정과 동시에 보증금이 처리되고, 거래는 **더 이상 앞으로 가지 않는다**.
 * - **`presigned`에서 분쟁 진입이 없다** — 후원자의 "계좌를 못 쓴다"는 주장은
 *   상태가 아니라 **증거**다(§5.2b). 상태로 받으면 원화 마감 시계가 멈추고
 *   그 순간 무한 옵션이 열린다(§7.6 R4-H1).
 * - **`presigned → settling`** — 앱을 거치지 않은 릴리스를 **체인에서 관측**한
 *   경우다. 고객은 `presigned`에서 이미 후원자 사전서명을 들고 있어 원화 확인 전에도
 *   스스로 릴리스할 수 있다(자기 손해). 어드민 핸들러는 이 전이를 쓰지 않는다
 *   (`canActOnSignRequest`가 막는다) — 체인이 먼저 말한 걸 장부가 따라갈 뿐이다.
 * - **`settling`은 되돌아가지 않는다**(O-005) — 멤풀 이탈은 **같은 tx 재브로드캐스트**로
 *   대응한다. 종결이 `remitted`로 돌아가는 전이는 의미가 없다.
 * - **`… → swept`** — 어드민이 만드는 상태가 아니라 **체인에서 관측**하는 결과다
 *   (O-006). 에스크로를 소모한 tx의 증인에 **타임락 리프**가 있을 때만 간다 —
 *   그 증거 없이는 워처도 이 전이를 쓰지 않는다. 펀딩 컨펌 이후 어느 상태에서든
 *   일어날 수 있다.
 */
export const ONCHAIN_TRANSITIONS: Record<OnchainState, readonly OnchainState[]> = {
  listed: ['bonded', 'cancelled'],
  bonded: ['funded', 'refunding', 'cancelled'],
  funded: ['presigned', 'refunding', 'bonded', 'swept'],
  presigned: ['remitted', 'refunding', 'settling', 'bonded', 'swept'],
  remitted: ['settling', 'disputed', 'swept'],
  disputed: ['settling', 'swept'],
  refunding: ['settling', 'swept'],
  settling: ['released', 'refunded', 'sponsor_wins', 'customer_wins', 'swept'],

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
  /** 고객이 마감(`ACCOUNT_WINDOW_SEC`) 안에 계좌를 공개하지 않음 */
  REFUND_CUSTOMER_LATE: 'refund:customer-late',
  /** `funded` 진입 시 후원자 보증금이 이미 만료 (O-015) */
  REFUND_BOND_EXPIRED: 'refund:bond-expired',
  /**
   * 후원자가 **송금 마감 전에** "계좌를 쓸 수 없다"고 이의를 냈고 그대로 마감이 찼다.
   *
   * **잠정 사유다.** 누구 과실인지 사람이 봐야 해서(§5.2b) 보증금을 양쪽 다 붙잡아
   * 둔다(`hold`). 어드민이 증거를 보고 `refund:customer-late`(계좌가 정말 나빴다)나
   * `refund:sponsor-timeout`(이의가 근거 없다)으로 **사유를 바꾸는 순간** 집행된다.
   * 환불 tx는 사유와 무관하게 같은 모양이라 고객 서명은 그대로 유효하다.
   */
  REFUND_ACCOUNT_DISPUTED: 'refund:account-disputed',
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
  /**
   * `bonded → cancelled` — 마감까지 약정 금액이 컨펌되지 않음.
   *
   * 고객이 아예 안 쐈든, 쐈다가 RBF로 되돌렸든, 수수료가 낮아 안 잡혔든
   * **전부 여기 하나로 모인다.** 우리가 보는 건 "마감 안에 컨펌됐는가"뿐이고,
   * 셋 다 고객이 통제하는 일이다.
   */
  CANCEL_NO_FUNDING: 'cancel:no-funding',
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
 * - `hold`    — **사람이 판정할 때까지 손대지 않는다** (계좌 이의, §5.2b)
 *
 * ⚠️ 보증금은 **결정 시점**에 처리한다 — 종결 tx 컨펌 때가 아니다(리뷰 #8).
 * 환불 tx는 고객 서명이 있어야 나가는데, 컨펌 때 몰수하면 `refund:customer-late`처럼
 * **몰수당할 쪽이 그 시점을 쥔다** — HTLC가 만료될 때까지 서명을 미루면 몰수가 사라진다.
 */
export type BondDisposition = 'refund' | 'forfeit' | 'expired' | 'none' | 'hold';

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
  'refund:account-disputed': {
    // 잠정 사유 — 어드민이 증거를 보고 customer-late / sponsor-timeout으로 바꾼다.
    terminal: 'refunded',
    sponsorBond: 'hold', customerBond: 'hold',
    arbitrated: false, label: '계좌 이의 — 누구 과실인지 판정 대기',
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
    // 되돌린 경우도 여기다. 후원자를 기다리게 만든 뒤 빼간 것이라 더 나쁘지
    // 않을 이유가 없고, 판정 기준("마감 안에 컨펌됐는가")도 같다.
    terminal: 'cancelled',
    sponsorBond: 'refund', customerBond: 'forfeit',
    arbitrated: false, label: '마감까지 펀딩이 컨펌되지 않음',
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
 * **O-001 · O-014.** `bonded` 이후 `cancelled`로 가려면 **"이 주소에 컨펌된 UTXO가
 * 없다"** 를 체인에서 확인해야 한다.
 *
 * 멤풀은 보지 않는다 — 판정 기준이 "마감 안에 컨펌됐는가"뿐이라 볼 이유가 없다.
 * 대신 **컨펌 여부는 반드시 본다**: 마감 직전에 들어온 펀딩이 컨펌됐는데 취소로
 * 밀어버리면, 아무도 안 보는 2-of-3 주소에 자금이 남는다.
 *
 * ⚠️ **판정은 주소 기준이다. txid가 아니다.** 고객이 수수료를 올리면 txid가
 * 바뀌므로, txid를 쫓으면 정직한 고객이 "사라진" 것으로 보인다. 교체본도 같은
 * 주소로 가므로 주소로 보면 안 놓친다. txid가 필요한 건 그 UTXO를 **소모할 때**뿐이다.
 *
 * `escrowUnfunded`가 `undefined`인 건 **"모른다"** 다(조회 실패). 모르면 막는다 —
 * 조회 실패를 '없음'으로 뭉개는 게 정확히 `FundStatus`에서 겪은 사고다.
 *
 * ⚠️ 마감 직후 늦게 컨펌되는 경우가 남는다. 그때 자금은 **갇히지 않는다** —
 * 고객 키는 nostr 키에서 결정론적으로 파생되고, `{A,C}`로 협조 환불이 되며,
 * 최후에는 타임락 리프가 받는다. 그게 그 리프가 존재하는 이유다.
 * 워처는 취소된 주문의 주소도 한동안 계속 봐야 한다(P4).
 */
export function canCancelOnchain(
  from: OnchainState,
  escrowUnfunded?: boolean,
): boolean {
  if (!canOnchainTransition(from, 'cancelled')) return false;
  // listed 단계엔 주소 자체가 없다 — 확인할 대상이 없으므로 그냥 간다.
  if (from === 'listed') return true;
  return escrowUnfunded === true;
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

/**
 * 서명 요청이 가리키는 종결 (kind 1111 `purpose` 태그).
 *
 * `rescue`는 FSM 밖이다 — 약정과 다른 모양으로 들어온 자금(금액 불일치, 이중 송금,
 * 취소 뒤 늦은 펀딩, 확정 뒤 추가 입금)을 고객에게 돌려주는 `{A,C}` tx다.
 */
export type SignPurpose = 'release' | 'refund' | 'dispute-customer' | 'dispute-sponsor' | 'rescue';

export function isRefundKind(kind: SettlementKind | undefined): boolean {
  return kind !== undefined && kind.startsWith('refund:');
}

/** 사유 → 서명 요청 purpose. 사유가 곧 누구에게 무엇을 받아야 하는지를 정한다. */
export function signPurposeFor(kind: SettlementKind): Exclude<SignPurpose, 'rescue'> {
  if (kind === 'release') return 'release';
  if (kind === 'sponsor_win') return 'dispute-sponsor';
  if (kind === 'customer_win') return 'dispute-customer';
  return 'refund';
}

/** 사유 → 서명해야 하는 쪽 (어드민 말고). `{A,S}`만 후원자, 나머지는 전부 고객이다 */
export function awaitingSignerFor(kind: SettlementKind): 'customer' | 'sponsor' {
  return kind === 'sponsor_win' ? 'sponsor' : 'customer';
}

/**
 * 이 서명 요청이 **아직 쓸모 있는가.**
 *
 * ⚠️ 화면이 "서명 요청이 스토어에 있다"만 보고 버튼을 띄우면 안 된다.
 * kind 1111은 릴레이에 남아 있어 **새로고침할 때마다 다시 배달되므로**,
 * 로컬에서 지워도 되살아난다. 실제로 **종결된 주문에 "서명하고 보내기"가
 * 계속 떠 있었다**(2026-09-23).
 *
 * **진실은 FSM이다.** 어드민 핸들러도 같은 함수로 막는다(리뷰 #8) — 화면만
 * 막으면 수정한 클라이언트가 `remitted`에서 환불 서명을 보내 원화와 BTC를 다 가져간다.
 *
 * - `settling`·터미널 → **무조건 아니다.** 이미 브로드캐스트됐거나 끝났다
 * - `release` → `remitted`(고객이 입금을 확인할 수 있는 시점)이거나
 *   `disputed`(양쪽 합의 릴리스로 빠져나가는 길, O-011)일 때만
 * - `refund` → `refunding`일 때만. 결정이 상태에 박힌 뒤에만 환불 tx가 존재한다
 * - 분쟁 판정 집행 → `disputed`이고 **판정 사유가 그 purpose와 맞을 때만**
 * - `rescue` → FSM과 무관하다. 소모할 UTXO가 약정 밖의 것인지는 따로 확인한다
 */
export function canActOnSignRequest(
  state: OnchainState,
  purpose: SignPurpose,
  settlementKind?: SettlementKind,
): boolean {
  if (purpose === 'rescue') return true;
  if (isOnchainTerminal(state) || state === 'settling') return false;

  switch (purpose) {
    case 'release': return state === 'remitted' || state === 'disputed';
    case 'refund': return state === 'refunding';
    case 'dispute-customer': return state === 'disputed' && settlementKind === 'customer_win';
    case 'dispute-sponsor': return state === 'disputed' && settlementKind === 'sponsor_win';
  }
}
