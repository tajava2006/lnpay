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
 * ── 내용에 무엇을 담지 않나
 *
 * NIP-17이 내용을 가려주지만, 수신자가 키를 어디에 로그인해 뒀는지 우리는 모른다.
 * 그래서 금액·계좌·상대 신원은 넣지 않는다. "무슨 일이 생겼고 어디로 가면 되는지"만
 * 알리고 나머지는 앱에서 보게 한다.
 */

/** 앱으로 돌아오는 경로. 알림만 보고 뭘 해야 할지 모르면 소용이 없다. */
const APP_URL = 'https://customer.hoppe-relay.it.com';

function line(body: string, tab?: 'request' | 'fulfill' | 'history'): string {
  const url = tab ? `${APP_URL}/?tab=${tab}` : APP_URL;
  return `[페어바이] ${body}\n${url}`;
}

export const NOTIFY = {
  /** 후원자가 붙고 검증도 끝났다. 고객이 결제해야 거래가 시작된다. */
  customerShouldPay: () =>
    line('후원자가 확정되었습니다. 결제하시면 거래가 시작됩니다.', 'request'),

  /** 결제가 확인됐다. 고객이 계좌를 보내야 후원자가 송금할 수 있다. */
  customerShouldSendAccount: () =>
    line('결제가 확인되었습니다. 입금받을 계좌 정보를 보내주세요.', 'request'),

  /** 후원자가 송금을 마쳤다고 알려왔다. 고객이 확인하고 컨펌해야 한다. */
  customerShouldConfirm: () =>
    line('후원자가 원화를 보냈다고 알려왔습니다. 입금을 확인하고 컨펌해 주세요.', 'request'),

  /** 계좌가 도착했다. 후원자가 원화를 보낼 차례다. */
  sponsorShouldRemit: () =>
    line('계좌 정보가 도착했습니다. 원화를 송금하고 송금 완료를 눌러주세요.', 'fulfill'),

  /** 거래가 정상 종료됐다. */
  customerCompleted: () =>
    line('거래가 완료되었습니다.', 'history'),
  sponsorCompleted: () =>
    line('거래가 완료되었습니다. BTC가 지급됩니다.', 'history'),

  /** 거래가 취소됐다. */
  cancelled: () =>
    line('거래가 취소되었습니다.', 'history'),

  /** 분쟁 판정 결과. */
  disputeResolved: (won: boolean) =>
    line(won
      ? '분쟁 판정이 끝났습니다. 회원님께 유리하게 결정되었습니다.'
      : '분쟁 판정이 끝났습니다. 자세한 내용은 앱에서 확인해 주세요.', 'history'),
} as const;
