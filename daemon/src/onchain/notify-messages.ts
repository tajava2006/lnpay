/**
 * 온체인 트랙 알림 문구 (PLAN-ONCHAIN-TRACK §6.2 · §7.5)
 *
 * 라이트닝판(`../ln/notify-messages.ts`)과 **문구 형식·통로를 공유**한다.
 * `Notice`·`asPush`·`asDirectMessage`를 그대로 쓰고, 여기서는 **무엇을 언제
 * 누구에게**만 정한다.
 *
 * ── 온체인은 알림이 더 중요하다
 *
 * 라이트닝에서는 마감을 놓쳐도 대개 시간만 버렸다. 여기서는 **마감을 놓치면
 * 보증금이 몰수되고 온체인 수수료를 두 번 문다.** 게다가 `funded → presigned`
 * 15분처럼 **앱이 깨어 있어야만** 지나갈 수 있는 구간이 있다 — 그 구간의 알림은
 * 안내가 아니라 **기능의 일부**다.
 *
 * 그래서 "당신 차례입니다"뿐 아니라 **마감 임박 경고**도 보낸다(§7.5의 유예 경고).
 *
 * 문구는 **상대방**으로 적는다 — 고객·후원자는 쿠팡 대리구매 시절 이름이라 온체인에서 안 읽힌다
 * (2026-09-25). 창 길이는 `timing.ts` 상수에서 만든다 — 숫자를 박아 두면 창을 바꿀 때 따로 논다.
 *
 * ── 표를 `Record<OnchainState, …>`로 못박은 이유
 *
 * 라이트닝에서 `invoiced`를 추가했을 때 이 표를 빠뜨려서, 거래가 실제로 멈추는
 * 단계에 알림이 없었다(2026-09-19). 상태를 추가하면 **빌드가 깨지게** 한다.
 * 알림이 필요 없는 상태는 `null`을 **명시**한다 — 빠뜨린 것과 구분된다.
 */
import {
  ACCOUNT_WINDOW_SEC, FUNDING_WINDOW_SEC, KRW_WINDOW_SEC, PRESIGN_WINDOW_SEC, durationText, type OnchainState,
} from '@sajwo-tracker/shared/onchain';
import type { Notice } from '../ln/notify-messages';

export const ONCHAIN_NOTIFY = {
  // ── 고객 차례 ──

  /** 후원자 보증금이 잡혔다 = 클레임 성립. 고객이 `FUNDING_WINDOW_SEC` 안에 펀딩해야 한다. */
  customerShouldFund: (): Notice => ({
    body: `사는 사람이 정해졌습니다. ${durationText(FUNDING_WINDOW_SEC)} 안에 에스크로 주소로 보내고 컨펌까지 `
      + '마쳐주세요. 늦으면 보증금이 몰수됩니다.',
    tab: 'history', track: 'onchain',
  }),

  /** 후원자 사전서명이 검증됐다. 고객이 `ACCOUNT_WINDOW_SEC` 안에 계좌를 공개해야 한다. */
  customerShouldSendAccount: (): Notice => ({
    body: `상대방이 서명을 마쳤습니다. ${durationText(ACCOUNT_WINDOW_SEC)} 안에 입금받을 계좌 정보를 보내주세요.`,
    tab: 'history', track: 'onchain',
  }),

  /** 후원자가 송금을 주장했다. **가장 급한 알림** — 상대는 이미 돈을 보내놓고 기다린다. */
  customerShouldConfirm: (): Notice => ({
    body: '상대방이 원화를 보냈다고 알려왔습니다. 입금을 확인해 주세요.',
    tab: 'history', track: 'onchain',
  }),

  /**
   * `remitted` 마감 2시간 전 (§7.5). 느린 고객 대부분이 여기서 스스로 끝낸다 —
   * 그러면 어드민이 안 불려 나온다.
   */
  customerDisputeSoon: (): Notice => ({
    body: '곧 분쟁으로 넘어갑니다. 입금을 확인해 주세요.',
    tab: 'history', track: 'onchain',
  }),

  /**
   * 환불 서명 요청. `{A,C}`라 **어드민 혼자서는 환불도 못 한다**(§5.2 R1-M4).
   * 고객이 안 오면 자기 돈이 잠긴 채로 남는다.
   */
  customerShouldSignRefund: (): Notice => ({
    body: '거래가 환불로 넘어갔습니다. 환불 서명이 필요합니다 — 서명해야 에스크로가 돌아옵니다.',
    tab: 'history', track: 'onchain',
  }),

  /** 분쟁 판정이 났다 — 이긴 쪽이 서명해야 집행된다(`{A,S}`·`{A,C}`) */
  winnerShouldSign: (): Notice => ({
    body: '분쟁 판정이 났습니다. 앱을 열어 판정 집행에 서명해 주세요 — 서명해야 비트코인이 움직입니다.',
    tab: 'history', track: 'onchain',
  }),

  /** 판정이 났다 — 진 쪽에게 */
  rulingDecided: (): Notice => ({
    body: '분쟁 판정이 났습니다. 자세한 내용은 앱에서 확인해 주세요.',
    tab: 'history', track: 'onchain',
  }),

  /**
   * 환불로 넘어갔다 — 후원자에게. **원화를 보내면 안 된다**는 걸 말해야 한다.
   * 이 알림이 없으면 계좌를 이미 본 후원자가 늦게 송금할 수 있다.
   */
  sponsorTradeRefunded: (): Notice => ({
    body: '마감이 지나 거래가 환불로 넘어갔습니다. 원화를 보내지 마세요.',
    tab: 'history', track: 'onchain',
  }),

  // ── 후원자 차례 ──

  /**
   * 펀딩이 컨펌돼 가격이 확정됐다(T0). 앱이 자동 서명하지만 **깨어 있어야** 한다.
   * 15분은 고민할 시간이 아니라 앱이 깨어나는 시간이다.
   */
  sponsorShouldPresign: (): Notice => ({
    body: `입금이 확인되어 금액이 확정됐습니다. 앱을 열어 ${durationText(PRESIGN_WINDOW_SEC)} 안에 서명을 마쳐주세요.`,
    tab: 'history', track: 'onchain',
  }),

  /** 계좌가 도착했다. 여기서부터 30분 (O-013 — 고객 지연이 이 창을 깎지 않는다). */
  sponsorShouldRemit: (): Notice => ({
    body: `계좌 정보가 도착했습니다. ${durationText(KRW_WINDOW_SEC)} 안에 원화를 보내고 송금 완료를 눌러주세요.`,
    tab: 'history', track: 'onchain',
  }),

  // ── 양쪽 ──

  /** 분쟁이 열렸다. 증거를 올려야 판정이 된다 (§7.7 입증책임). */
  disputeOpened: (): Notice => ({
    body: '분쟁이 열렸습니다. 이체 내역·계좌 내역 등 증거를 채팅에 올려주세요.',
    tab: 'history', track: 'onchain',
  }),

  disputeResolved: (won: boolean): Notice => ({
    body: won
      ? '분쟁 판정이 끝났습니다. 회원님께 유리하게 결정되었습니다.'
      : '분쟁 판정이 끝났습니다. 자세한 내용은 앱에서 확인해 주세요.',
    tab: 'history', track: 'onchain',
  }),

  /** 종결 tx가 컨펌됐다. */
  released: (role: 'customer' | 'sponsor'): Notice => ({
    body: role === 'customer'
      ? '거래가 완료되었습니다.'
      : '거래가 완료되었습니다. 비트코인이 등록한 주소로 들어왔습니다.',
    tab: 'history', track: 'onchain',
  }),

  /**
   * 환불 컨펌. **보상을 약속하지 않는다**(§6.0) — 충당은 운영 재량이고,
   * "보상받습니다"를 띄우는 순간 권리가 되어 새 분쟁이 된다.
   */
  refunded: (): Notice => ({
    body: '에스크로가 환불되었습니다. 자세한 내용은 앱에서 확인해 주세요.',
    tab: 'history', track: 'onchain',
  }),

  cancelled: (): Notice => ({
    body: '거래가 취소되었습니다.',
    tab: 'history', track: 'onchain',
  }),
} as const;

/** 한쪽에게만 가는 알림도 있으므로 역할별로 optional이다. */
export interface StateNotices {
  customer?: Notice;
  sponsor?: Notice;
}

/**
 * **상태에 진입했을 때** 누구에게 무엇을 보내나.
 *
 * `null`은 "보낼 게 없다"를 **명시**한 것이다:
 * - `listed` — 등록한 본인만 아는 상태. 후원자에게는 오더북이 알림이다
 * - `settling` — 종결 tx를 기다리는 구간. 결과는 터미널에서 알린다
 * - `swept` — **어드민이 죽어야 일어나는 종결**이다. 그 상황에서는 이 코드가
 *   돌지 않으므로 알림을 정의해봐야 거짓말이다
 */
export const ONCHAIN_TRANSITION_NOTICES: Record<OnchainState, StateNotices | null> = {
  listed: null,
  bonded: { customer: ONCHAIN_NOTIFY.customerShouldFund() },
  funded: { sponsor: ONCHAIN_NOTIFY.sponsorShouldPresign() },
  presigned: { customer: ONCHAIN_NOTIFY.customerShouldSendAccount() },
  remitted: { customer: ONCHAIN_NOTIFY.customerShouldConfirm() },
  disputed: {
    customer: ONCHAIN_NOTIFY.disputeOpened(),
    sponsor: ONCHAIN_NOTIFY.disputeOpened(),
  },
  // 환불 결정 — 고객이 서명해야 끝난다(어드민 혼자 못 한다). 후원자에게는 멈추라고 알린다.
  refunding: {
    customer: ONCHAIN_NOTIFY.customerShouldSignRefund(),
    sponsor: ONCHAIN_NOTIFY.sponsorTradeRefunded(),
  },
  settling: null,

  released: {
    customer: ONCHAIN_NOTIFY.released('customer'),
    sponsor: ONCHAIN_NOTIFY.released('sponsor'),
  },
  refunded: {
    customer: ONCHAIN_NOTIFY.refunded(),
    sponsor: ONCHAIN_NOTIFY.refunded(),
  },
  sponsor_wins: {
    customer: ONCHAIN_NOTIFY.disputeResolved(false),
    sponsor: ONCHAIN_NOTIFY.disputeResolved(true),
  },
  customer_wins: {
    customer: ONCHAIN_NOTIFY.disputeResolved(true),
    sponsor: ONCHAIN_NOTIFY.disputeResolved(false),
  },
  cancelled: {
    customer: ONCHAIN_NOTIFY.cancelled(),
    sponsor: ONCHAIN_NOTIFY.cancelled(),
  },
  swept: null,
};

/**
 * 전이와 무관하게 **시계가 부르는** 알림들. 전이표에 안 들어가므로 따로 둔다.
 *
 * - `accountInfoArrived` — `presigned` 안에서 "고객이 계좌를 보냈는가"만 바뀐다.
 *   상태는 그대로인데 **후원자가 원화를 보낼 수 있게 되는 순간**이 정확히 여기다.
 * - `disputeSoon` — `remitted` 마감 2시간 전 유예 경고(§7.5). **주문당 한 번**
 * - `rulingSignatureNeeded` / `rulingDecided` — 분쟁 판정. 상태(`disputed`)는 그대로인데
 *   이긴 쪽이 서명해야 집행된다
 *
 * (환불 서명 요청은 이제 `refunding` **전이** 알림이다 — 전에는 이 표에만 있고
 * 부르는 곳이 없어서 한 번도 안 나갔다. 리뷰 #8.)
 */
export const ONCHAIN_TIMER_NOTICES = {
  accountInfoArrived: (): Notice => ONCHAIN_NOTIFY.sponsorShouldRemit(),
  disputeSoon: (): Notice => ONCHAIN_NOTIFY.customerDisputeSoon(),
  rulingSignatureNeeded: (): Notice => ONCHAIN_NOTIFY.winnerShouldSign(),
  rulingDecided: (): Notice => ONCHAIN_NOTIFY.rulingDecided(),
} as const;
