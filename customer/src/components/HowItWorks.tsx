import { useState, type ReactNode } from 'react';
import { BUTTON } from '@sajwo-tracker/shared';
import { ACCOUNT_WINDOW_SEC, durationText } from '@sajwo-tracker/shared/onchain';
import type { Track } from '../routing';
import { ui } from '../ui';
import { canInstallUserscript } from '../buyer/components/UserscriptGuide';

/**
 * 팔기 탭 맨 위 — 원화가 어디로 가는지와 쿠팡 결제에 쓰는 법 (2026-10-24 피드백)
 *
 * 쿠팡 얘기가 앱 안에서는 데스크톱 전용 유저스크립트 안내에만 있었다. 그래서 "앱이 쿠팡과 마법처럼 연동된다"로
 * 알아듣거나, 자기 통장을 넣고 둘이 해 보고는 "쿠팡 계좌가 아니라 상대 계좌가 왔다"고 제보했다. 사실은 단순하다:
 * 원화는 **파는 사람이 보낸 계좌로만** 가고, 쿠팡 가상계좌는 그 계좌로 고를 수 있는 것 중 하나일 뿐이다.
 *
 * 운영자가 적어 달라고 한 것을 빠짐없이 둔다 — 쿠팡 가상계좌는 두 트랙 다 되지만 **자동 입력은 라이트닝만**(온체인은
 * 고액용이라 연동을 안 만들었다), **반드시 무통장입금**, 무통장입금은 **입금 기한이 하루**라 오래 걸어 둘 땐 먼저 올리고
 * 나중에 붙이기, 가격이 자주 바뀌는 상품은 어렵다. 붙이기가 실제로 끝까지 도는 건 `coupang-attach-autosend.test.ts`가 지킨다.
 *
 * 폰에서도 보여야 하므로 유저스크립트 안내와 달리 숨기지 않는다. 처음 온 사람(내 판매가 없음)에게는 펼쳐서, 이미 쓰는
 * 사람에게는 한 줄로 접어서 보여준다 — 무엇을 펼칠지는 부모가 정한다.
 */
export function HowItWorks({ track, defaultOpen }: { track: Track; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const ln = track === 'ln';

  return (
    <details open={open} onToggle={e => setOpen(e.currentTarget.open)} style={{ ...ui.panel, marginBottom: 20 }}>
      <summary style={styles.summary}>어떻게 돌아가나요? — 원화는 내가 정한 계좌로 옵니다</summary>

      {ln ? <LnSteps /> : <OnchainSteps />}

      <Section title="쿠팡 결제에 쓰기">
        <p style={styles.text}>
          원화 받을 계좌로 <b>쿠팡 무통장입금 가상계좌</b>를 보내면, 사는 사람이 보낸 원화로 내 쿠팡 주문이 결제됩니다 —
          비트코인으로 쿠팡 결제를 한 셈입니다. 라이트닝·온체인 어느 쪽이든 됩니다.
        </p>
        <ul style={styles.list}>
          <li style={styles.item}>
            <b>결제 수단은 반드시 무통장입금으로 고르세요.</b> 그래야 쿠팡이 입금할 가상계좌를 줍니다. 카드 결제처럼 나중에
            취소·환불될 수 있는 결제는 에스크로로 묶을 수 없어서 쓸 수 없습니다.
          </li>
          <li style={styles.item}>
            <b>금액은 1원까지 같아야 합니다.</b> 판매 금액이 쿠팡 주문 금액과 다르면 쿠팡이 입금으로 인식하지 않습니다.
          </li>
          <li style={styles.item}>
            <b>쿠팡 무통장입금은 입금 기한이 하루로 정해져 있습니다.</b> 그 안에 사는 사람의 송금이 끝나야 합니다.
          </li>
          <li style={styles.item}>
            <b>앱이 쿠팡과 연결돼 있는 건 아닙니다.</b> 사는 사람에게는 내가 보낸 계좌가 그대로 전달되고, 원화는 그
            계좌로만 갑니다. 내 통장을 보냈다면 사는 사람 화면에도 내 통장이 뜨는 게 맞습니다.
          </li>
        </ul>
      </Section>

      {ln ? <LnCoupang /> : <OnchainCoupang />}
    </details>
  );
}

function LnSteps() {
  return (
    <ol style={styles.steps}>
      <li style={styles.item}>
        <b>비트코인을 에스크로에 맡깁니다.</b> 사는 사람이 붙으면 라이트닝으로 결제해 두고, 거래가 끝날 때까지 에스크로가
        들고 있습니다.
      </li>
      <li style={styles.item}>
        <b>원화 받을 계좌는 내가 정해서 보냅니다.</b> 사는 사람이 받을 준비를 마치면 '{BUTTON.sendAccount}'로
        은행·계좌번호·예금주를 보내고, 사는 사람은 <b>그 계좌로</b> 원화를 보냅니다. 어떤 계좌든 됩니다 — 내 통장이어도 됩니다.
      </li>
      <li style={styles.item}>
        <b>입금을 확인하면 끝납니다.</b> 그 계좌에 원화가 들어온 걸 보고 '{BUTTON.confirmPaid}'을 누르면 비트코인이 사는
        사람에게 갑니다.
      </li>
    </ol>
  );
}

function OnchainSteps() {
  return (
    <ol style={styles.steps}>
      <li style={styles.item}>
        <b>사는 사람이 붙으면 비트코인을 에스크로 주소로 보냅니다.</b> 컨펌까지 끝나야 하고, 가격은 컨펌될 때의 시세로
        정해집니다.
      </li>
      <li style={styles.item}>
        <b>원화 받을 계좌는 내가 정해서 보냅니다.</b> 가격이 정해지고 상대 앱이 확인을 마치면 '{BUTTON.sendAccount}'로 보내고,
        사는 사람은 <b>그 계좌로</b> 원화를 보냅니다. 어떤 계좌든 됩니다 — 내 통장이어도 됩니다.
      </li>
      <li style={styles.item}>
        <b>입금을 확인하면 끝납니다.</b> 그 계좌에 원화가 들어온 걸 보고 '{BUTTON.confirmReleased}'를 누르면 비트코인이 사는
        사람에게 넘어갑니다.
      </li>
    </ol>
  );
}

function LnCoupang() {
  const desktop = canInstallUserscript();
  return (
    <>
      <Section title="쿠팡 가상계좌 자동 입력 — 라이트닝만">
        <p style={styles.text}>
          PC 크롬에 유저스크립트를 설치하면, 쿠팡 주문 상세 페이지의 금액과 가상계좌가 이 앱에 자동으로 들어와 쿠팡과 연동된
          것처럼 동작합니다 — <b>쿠팡의 모든 물건을 비트코인으로 결제할 수 있게 되는 셈</b>이죠. 하는 일은 계좌를 옮겨 적는
          것뿐이고, 쿠팡 주문이나 결제를 대신 하지는 않습니다. 설치하지 않으면 금액과 계좌를 직접 입력하면 되고, 결과는 같습니다.
        </p>
        <p style={styles.text}>
          {desktop
            ? <>설치 방법은 이 화면 맨 아래 <b>'쿠팡 가상계좌 자동 입력'</b>에 있습니다.</>
            : <>폰에서는 설치할 수 없습니다 — PC 크롬에서 이 앱을 열면 설치 방법이 보입니다.</>}
        </p>
      </Section>

      <Section title="판매를 오래 걸어 두고 싶을 때">
        <p style={styles.text}>
          무통장입금 주문은 입금 기한이 하루라, 쿠팡 주문부터 넣고 판매를 며칠씩 걸어 두면 그 사이 가상계좌가 죽습니다.
          그럴 땐 판매를 먼저 올리고, 사는 사람이 붙은 뒤에 쿠팡 주문을 붙이세요.
        </p>
        <ol style={styles.steps}>
          <li style={styles.item}>금액만 쿠팡 주문 금액과 <b>1원까지 똑같이</b> 맞춰 판매를 먼저 올립니다. 유효기간은 길게 잡아도 됩니다.</li>
          <li style={styles.item}>사는 사람이 붙으면, 그때 PC에서 쿠팡에 <b>무통장입금</b>으로 주문합니다.</li>
          <li style={styles.item}>
            유저스크립트가 읽어 온 주문이 이 화면 위 <b>'감지된 주문'</b>에 뜹니다. <b>'…원에 연결'</b> 버튼을 누르면 이미 올린
            판매에 그 가상계좌가 붙습니다(금액이 같은 판매만 보입니다).
          </li>
          <li style={styles.item}>
            붙인 가상계좌는 사는 사람이 받을 준비를 마치는 순간 <b>자동으로 전달</b>됩니다. 그때 PC에서 이 앱이 열려 있어야
            하고, 닫혀 있었다면 다시 열면 바로 보냅니다(폰에서 '{BUTTON.sendAccount}'로 같은 가상계좌를 직접 입력해 보내도
            됩니다). 그때부터 쿠팡 입금 기한(하루) 안에 송금이 끝나야 합니다.
          </li>
        </ol>
        <ul style={styles.list}>
          <li style={styles.item}>계좌 정보를 이미 보낸 판매에는 붙일 수 없습니다.</li>
          <li style={styles.item}>
            폰에서 올린 판매에 PC에서 붙이려면 PC에도 <b>같은 키</b>가 있어야 합니다(화면 위 🔑 → 가져오기). 유저스크립트에는
            그 PC 앱의 키가 들어가고, 붙일 판매도 그 키의 판매 중에서 찾습니다.
          </li>
          <li style={styles.item}>
            <b>가격이 자주 바뀌는 상품</b>은 이렇게 쓰기 어렵습니다 — 판매를 올린 뒤 쿠팡 가격이 바뀌면 금액이 안 맞아 붙일
            수 없습니다. 사는 사람이 붙은 뒤 취소하면 보증금을 잃을 수 있으니, 그런 상품은 쿠팡 주문을 먼저 넣고 '감지된
            주문'에서 바로 판매로 올리세요(이때 판매 기한은 쿠팡 입금 기한을 따라갑니다). 앞으로 개선하려고 합니다.
          </li>
        </ul>
      </Section>
    </>
  );
}

function OnchainCoupang() {
  return (
    <Section title="온체인은 자동 입력이 없습니다">
      <p style={styles.text}>
        온체인 트랙은 <b>고액 거래</b>를 위해 만들었습니다. 라이트닝은 금액에 비례하는 수수료가 붙지만, 온체인은 채굴 수수료
        말고는 따로 드는 수수료가 없습니다. 쿠팡 주문 같은 일상적인 결제는 고액인 경우가 많지 않아 대부분 라이트닝의 금액 비례
        수수료가 채굴 수수료보다 낮습니다 — 그래서 쿠팡 자동 연동은 라이트닝 전용으로 두었습니다.
      </p>
      <p style={styles.text}>
        쿠팡에서 수십·수백만 원짜리 주문을 이 앱의 비트코인 결제로 하려면, 온체인에서 자동 연동 없이 쿠팡 가상계좌를
        '{BUTTON.sendAccount}'에 <b>직접 입력</b>해 보내세요. 계좌는 내 차례가 오고 {durationText(ACCOUNT_WINDOW_SEC)} 안에
        보내야 하니, 그때 쿠팡에 무통장입금으로 주문하면 하루짜리 입금 기한이 넉넉합니다.
      </p>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <p style={styles.subTitle}>{title}</p>
      {children}
    </>
  );
}

const styles = {
  summary: { fontSize: 14, fontWeight: 600 as const, color: '#374151', cursor: 'pointer' },
  steps: { margin: '8px 0 12px 0', paddingLeft: 20 },
  list: { margin: '0 0 12px 0', paddingLeft: 18 },
  item: { fontSize: 13, lineHeight: 1.7, color: '#4B5563', marginBottom: 6 },
  subTitle: { margin: '14px 0 4px 0', fontSize: 13, fontWeight: 700 as const, color: '#374151' },
  text: { margin: '0 0 8px 0', fontSize: 13, lineHeight: 1.7, color: '#4B5563' },
};
