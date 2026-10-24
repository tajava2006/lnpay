import { useState } from 'react';
import { BUTTON } from '@sajwo-tracker/shared';
import { ui } from '../../ui';
import { canInstallUserscript } from './UserscriptGuide';

/**
 * 라이트닝 팔기 탭 맨 위 — 원화가 어디로 가는지와 쿠팡 결제가 무엇인지 (2026-10-24 피드백)
 *
 * 쿠팡 얘기가 앱 안에서는 데스크톱 전용 유저스크립트 안내에만 있었다. 그래서 "앱이 쿠팡과 마법처럼 연동된다"로
 * 알아듣거나, 자기 통장을 넣고 둘이 해 보고는 "쿠팡 계좌가 아니라 상대 계좌가 왔다"고 제보했다. 사실은 단순하다:
 * 원화는 **파는 사람이 보낸 계좌로만** 가고, 쿠팡 가상계좌는 그 계좌로 고를 수 있는 것 중 하나일 뿐이다.
 * 폰에서도 보여야 하므로 유저스크립트 안내와 달리 숨기지 않는다.
 *
 * 처음 온 사람(내 판매가 없음)에게는 펼쳐서, 이미 쓰는 사람에게는 한 줄로 접어서 보여준다.
 */
export function HowItWorks({ defaultOpen }: { defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const desktop = canInstallUserscript();

  return (
    <details
      open={open}
      onToggle={e => setOpen(e.currentTarget.open)}
      style={{ ...ui.panel, marginBottom: 20 }}
    >
      <summary style={styles.summary}>어떻게 돌아가나요? — 원화는 내가 정한 계좌로 옵니다</summary>

      <ol style={styles.steps}>
        <li style={styles.step}>
          <b>비트코인을 에스크로에 맡깁니다.</b> 사는 사람이 붙으면 라이트닝으로 결제해 두고, 거래가 끝날 때까지
          에스크로가 들고 있습니다.
        </li>
        <li style={styles.step}>
          <b>원화 받을 계좌는 내가 정해서 보냅니다.</b> 사는 사람이 받을 준비를 마치면 '{BUTTON.sendAccount}'로
          은행·계좌번호·예금주를 보내고, 사는 사람은 <b>그 계좌로</b> 원화를 보냅니다. 어떤 계좌든 됩니다 — 내
          통장이어도 됩니다.
        </li>
        <li style={styles.step}>
          <b>입금을 확인하면 끝납니다.</b> 그 계좌에 원화가 들어온 걸 보고 '{BUTTON.confirmPaid}'을 누르면 비트코인이
          사는 사람에게 갑니다.
        </li>
      </ol>

      <p style={styles.subTitle}>쿠팡 결제에 쓰기</p>
      <p style={styles.text}>
        쿠팡에서 <b>무통장입금</b>으로 주문하면 쿠팡이 입금할 가상계좌를 줍니다. 그 가상계좌를 원화 받을 계좌로 보내면,
        사는 사람이 보낸 원화로 내 쿠팡 주문이 결제됩니다 — 비트코인으로 쿠팡 결제를 한 셈입니다. 판매 금액은 쿠팡 주문
        금액과 <b>1원까지 똑같이</b> 맞추세요. 다르면 쿠팡이 입금으로 인식하지 않습니다.
      </p>
      <p style={styles.text}>
        앱이 쿠팡과 연결돼 있는 건 아닙니다. 사는 사람에게는 내가 보낸 계좌가 그대로 전달되고, 원화는 그 계좌로만
        갑니다. 내 통장을 보냈다면 사는 사람 화면에도 내 통장이 뜨는 게 맞습니다.
      </p>
      <p style={{ ...styles.text, marginBottom: 0 }}>
        {desktop
          ? <>PC 크롬에서는 이 화면 아래 <b>'쿠팡 가상계좌 자동 입력'</b>(유저스크립트)을 설치하면 쿠팡 주문의 금액과
            가상계좌가 이 앱에 자동으로 들어와, 쿠팡과 연동된 것처럼 동작합니다 — 쿠팡의 모든 물건을 비트코인으로 결제할
            수 있게 되는 셈이죠. 설치하지 않으면 금액과 계좌를 직접 입력하면 되고, 결과는 같습니다.</>
          : <>PC 크롬에서 이 앱을 열면 쿠팡 주문의 금액과 가상계좌를 자동으로 채워 주는 유저스크립트를 쓸 수 있습니다 —
            쿠팡과 연동된 것처럼 동작해서 쿠팡의 모든 물건을 비트코인으로 결제할 수 있게 되는 셈이죠. 폰에서는 금액과
            계좌를 직접 입력하면 되고, 결과는 같습니다.</>}
      </p>
    </details>
  );
}

const styles = {
  summary: { fontSize: 14, fontWeight: 600 as const, color: '#374151', cursor: 'pointer' },
  steps: { margin: '12px 0 12px 0', paddingLeft: 20 },
  step: { fontSize: 13, lineHeight: 1.7, color: '#4B5563', marginBottom: 6 },
  subTitle: { margin: '0 0 4px 0', fontSize: 13, fontWeight: 700 as const, color: '#374151' },
  text: { margin: '0 0 8px 0', fontSize: 13, lineHeight: 1.7, color: '#4B5563' },
};
