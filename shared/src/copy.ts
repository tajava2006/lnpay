/**
 * 두 트랙·여러 화면이 같이 쓰는 문구
 *
 * 진행도 안내가 버튼을 **이름으로** 부른다("'원화 송금했어요'를 누릅니다"). 버튼 이름과 안내가 다른 파일에
 * 있으면 한쪽만 바뀌어 안내가 없는 버튼을 가리킨다 — 그래서 이름을 여기 한 벌만 둔다.
 */

/** 버튼 이름 */
export const BUTTON = {
  sendAccount: '계좌 정보 전달',
  remitted: '원화 송금했어요',
  /** 라이트닝 — 고객이 입금을 확인하면 지급된다 */
  confirmPaid: '입금 컨펌',
  /** 온체인 — 파는 사람이 입금을 확인하면 릴리스에 서명한다 */
  confirmReleased: '원화 입금을 확인했어요',
} as const;

/** 두 트랙 진행도가 같은 말을 하는 단계 */
export const STEP_TEXT = {
  sendAccount: `'${BUTTON.sendAccount}'로 입금받을 은행·계좌번호·예금주를 보냅니다.`,
  pressRemitted: `송금을 마쳤으면 '${BUTTON.remitted}'를 누릅니다.`,
  checkDeposit: '내 계좌에 원화가 들어왔는지 확인합니다.',
} as const;
