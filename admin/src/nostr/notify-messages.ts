/**
 * 알림 문구와 발송 시점
 *
 * ── 언제 보내나: "당신 차례입니다" 순간에만
 *
 * 거래는 대부분 기다리는 시간이다. 상태가 바뀔 때마다 보내면 알림이 소음이 되고,
 * 소음이 되면 정작 움직여야 할 때 놓친다. 그래서 **상대가 나를 기다리기 시작하는
 * 순간**에만 보낸다.
 *
 *   고객:   verified    — 결제해야 거래가 시작된다
 *           escrowed    — 계좌를 보내야 후원자가 송금할 수 있다
 *           remitted    — **후원자가 이미 돈을 보내놓고 기다린다.** 가장 급하다
 *   후원자: account-info 도착 — 이제 원화를 보낼 수 있다
 *
 * 완료·취소는 행동이 필요 없지만 결과를 알아야 하므로 양쪽에 보낸다.
 * 분쟁 중재는 예외 상황이고 채팅으로 이미 오가므로 알림을 따로 만들지 않는다.
 *
 * ── 문구는 한 벌, 통로는 두 개
 *
 * Web Push와 NIP-17이 같은 사건을 서로 다른 통로로 나른다. 문구를 두 벌로 두면
 * 한쪽만 고치는 일이 반드시 생기므로, 여기 한 표에서 양쪽 형식을 파생시킨다.
 *
 * ── 내용에 무엇을 담지 않나
 *
 * 두 통로 다 내용을 암호화하지만, 수신자가 어디서 열어보는지는 우리가 모른다.
 * 잠금화면에 그대로 뜰 수도 있다. 그래서 금액·계좌·상대 신원은 넣지 않고
 * "무슨 일이 생겼고 어디로 가면 되는지"만 알린다.
 */

/** 앱으로 돌아오는 경로. 알림만 보고 뭘 해야 할지 모르면 소용이 없다. */
const APP_URL = 'https://customer.hoppe-relay.it.com';

type Tab = 'request' | 'fulfill' | 'history';

/** 통로와 무관한 알림 한 건. */
export interface Notice {
  body: string;
  tab: Tab;
}

function path(tab: Tab): string {
  return tab === 'fulfill' ? '/' : `/?tab=${tab}`;
}

/** NIP-17 DM 본문 — 링크를 글로 붙인다. */
export function asDirectMessage(n: Notice): string {
  return `[페어바이] ${n.body}\n${APP_URL}${path(n.tab)}`;
}

/** Web Push 페이로드 — 제목·본문이 나뉘고 링크는 클릭 대상이 된다. */
export function asPush(n: Notice, tag?: string): { title: string; body: string; url: string; tag?: string } {
  return { title: '페어바이', body: n.body, url: path(n.tab), ...(tag ? { tag } : {}) };
}

export const NOTIFY = {
  /** 후원자가 붙고 검증도 끝났다. 고객이 결제해야 거래가 시작된다. */
  customerShouldPay: (): Notice =>
    ({ body: '후원자가 확정되었습니다. 결제하시면 거래가 시작됩니다.', tab: 'request' }),

  /** 결제가 확인됐다. 고객이 계좌를 보내야 후원자가 송금할 수 있다. */
  customerShouldSendAccount: (): Notice =>
    ({ body: '결제가 확인되었습니다. 입금받을 계좌 정보를 보내주세요.', tab: 'request' }),

  /** 후원자가 송금을 마쳤다고 알려왔다. 고객이 확인하고 컨펌해야 한다. */
  customerShouldConfirm: (): Notice =>
    ({ body: '후원자가 원화를 보냈다고 알려왔습니다. 입금을 확인하고 컨펌해 주세요.', tab: 'request' }),

  /** 계좌가 도착했다. 후원자가 원화를 보낼 차례다. */
  sponsorShouldRemit: (): Notice =>
    ({ body: '계좌 정보가 도착했습니다. 원화를 송금하고 송금 완료를 눌러주세요.', tab: 'fulfill' }),

  /** 거래가 정상 종료됐다. */
  customerCompleted: (): Notice =>
    ({ body: '거래가 완료되었습니다.', tab: 'history' }),
  sponsorCompleted: (): Notice =>
    ({ body: '거래가 완료되었습니다. BTC가 지급됩니다.', tab: 'history' }),

  /** 거래가 취소됐다. */
  cancelled: (): Notice =>
    ({ body: '거래가 취소되었습니다.', tab: 'history' }),

  /** 분쟁 판정 결과. */
  disputeResolved: (won: boolean): Notice => ({
    body: won
      ? '분쟁 판정이 끝났습니다. 회원님께 유리하게 결정되었습니다.'
      : '분쟁 판정이 끝났습니다. 자세한 내용은 앱에서 확인해 주세요.',
    tab: 'history',
  }),
} as const;
