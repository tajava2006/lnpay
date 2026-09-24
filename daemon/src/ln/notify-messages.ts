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
 *           invoiced    — 계좌를 보내야 후원자가 송금할 수 있다
 *           remitted    — **후원자가 이미 돈을 보내놓고 기다린다.** 가장 급하다
 *   후원자: escrowed    — 받을 인보이스를 등록해야 거래가 진행된다
 *           account-info 도착 — 이제 원화를 보낼 수 있다
 *
 * 상태를 추가하면 이 표도 같이 봐야 한다. `invoiced`를 넣으면서 한 번
 * 빠뜨렸고, 그동안 거래가 실제로 멈추는 단계에 알림이 없었다(2026-09-19).
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

/**
 * 앱 탭. **두 트랙이 같은 탭 구조를 공유한다** — 온체인과 라이트닝은 동등한
 * 거래 방법이라 한쪽을 다른 쪽 밑에 넣지 않는다(PLAN-ONCHAIN-TRACK §1.2).
 */
export type Tab = 'request' | 'fulfill' | 'history';

/** 어느 거래 방법인가. 생략하면 라이트닝 */
export type Track = 'ln' | 'onchain';

/** 통로와 무관한 알림 한 건. 온체인 트랙도 이 형식을 그대로 쓴다. */
export interface Notice {
  body: string;
  tab: Tab;
  track?: Track;
}

/**
 * 앱 안의 목적지.
 *
 * 기본값(라이트닝 + 사주기)은 쿼리 없이 루트다 — 주소가 짧을수록 알림에서
 * 돌아왔을 때 덜 낯설다.
 */
function path(notice: Notice, orderId?: string): string {
  const params = new URLSearchParams();
  if (notice.track === 'onchain') params.set('track', 'onchain');
  if (notice.tab !== 'fulfill') params.set('tab', notice.tab);
  // 오더를 알면 그 오더 화면으로 — 할 일(결제·인보이스·계좌·송금)이 거기 카드에 있다
  if (orderId) params.set('order', orderId);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

/** NIP-17 DM 본문 — 링크를 글로 붙인다. */
export function asDirectMessage(n: Notice): string {
  return `[페어바이] ${n.body}\n${APP_URL}${path(n)}`;
}

/**
 * Web Push 페이로드 — 제목·본문이 나뉘고 링크는 클릭 대상이 된다.
 * 오더 id는 묶음 태그이자 목적지다(누르면 그 오더 화면이 열린다).
 */
export function asPush(n: Notice, orderId?: string): { title: string; body: string; url: string; tag?: string } {
  return { title: '페어바이', body: n.body, url: path(n, orderId), ...(orderId ? { tag: orderId } : {}) };
}

/**
 * 구독 확인 — **푸시 전용**, 등록 직후 딱 한 번.
 *
 * 두 가지를 한다.
 *
 * **확인.** 유저는 "알림 켜기"를 누른 뒤 정말 켜졌는지 알 방법이 없다. 다음 거래
 * 전이까지 기다려야 아는데, 그때 안 오면 어디가 틀렸는지 되짚을 수가 없다.
 *
 * **첫 알림을 대신 맞아준다.** macOS는 브라우저가 처음 알림을 띄우려 할 때
 * "「Firefox」에서 알림을 보내려고 합니다" 같은 OS 권한 창을 먼저 띄운다.
 * 그걸 허용하는 사이 정작 그 첫 알림은 묻혀서 안 보인다. 그 자리를 실제 거래
 * 알림이 맞으면 "결제하세요"가 통째로 증발하는데, 이 문구가 대신 맞으면
 * 잃는 게 없다. 그 다음부터는 정상적으로 뜬다.
 *
 * NIP-17로는 보내지 않는다 — nostr 클라이언트는 권한 문제가 없고, 거기서는
 * 이 문구가 그냥 소음이다.
 */
export const PUSH_WELCOME = {
  title: '페어바이',
  body: '알림이 등록되었습니다. 거래가 회원님 차례가 되면 여기로 알려드립니다.',
  url: '/',
  tag: 'pairbuy-welcome',
} as const;

export const NOTIFY = {
  /** 후원자가 붙고 검증도 끝났다. 고객이 결제해야 거래가 시작된다. */
  customerShouldPay: (): Notice =>
    ({ body: '후원자가 확정되었습니다. 결제하시면 거래가 시작됩니다.', tab: 'request' }),

  /** 결제가 확인됐다. 이제 후원자가 받을 인보이스를 등록할 차례다. */
  // 보증금 — 전이가 아니라 홀드 인보이스가 생길 때 보낸다(클레임·의뢰 직후 화면을 떠났을 수 있다)
  customerShouldPayDeposit: (): Notice =>
    ({ body: '보증금을 결제하면 의뢰가 오더북에 올라갑니다.', tab: 'request' }),
  sponsorShouldPayDeposit: (): Notice =>
    ({ body: '보증금을 결제하면 의뢰가 확정됩니다. 제한 시간 안에 결제해 주세요.', tab: 'fulfill' }),

  sponsorShouldRegisterInvoice: (): Notice =>
    ({ body: '고객이 결제를 마쳤습니다. BTC 받을 인보이스를 등록해 주세요.', tab: 'fulfill' }),

  /** 후원자 인보이스가 확인됐다. 이제 고객이 계좌를 보낼 수 있다. */
  customerShouldSendAccount: (): Notice =>
    ({ body: '후원자가 받을 준비를 마쳤습니다. 입금받을 계좌 정보를 보내주세요.', tab: 'request' }),

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

  /**
   * 쿠팡 입금 기한이 지나 데몬이 닫았다. 누가 무엇을 돌려받는지는 사유마다 달라서(보증금 몰수 포함)
   * 여기서 단정하지 않는다 — 앱이 사유를 보여준다.
   */
  expired: (): Notice =>
    ({ body: '입금 기한이 지나 거래가 종료되었습니다. 자세한 내용은 앱에서 확인해 주세요.', tab: 'history' }),

  /** 어드민이 방치된 거래를 끊었다. */
  adminClosed: (): Notice =>
    ({ body: '거래가 오래 멈춰 있어 종료되었습니다. 결제한 금액은 환불됩니다.', tab: 'history' }),

  /** 분쟁 판정 결과. */
  disputeResolved: (won: boolean): Notice => ({
    body: won
      ? '분쟁 판정이 끝났습니다. 회원님께 유리하게 결정되었습니다.'
      : '분쟁 판정이 끝났습니다. 자세한 내용은 앱에서 확인해 주세요.',
    tab: 'history',
  }),
} as const;
