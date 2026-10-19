# 지정 거래 3차 확인 — D2 남은 자리 (작업 지시서)

> **임시 문서.** 1·2차 리뷰 반영(`772adc9`)을 `389f541`에서 다시 확인한 결과다. 남은 건 **D2(보증금 없는 지정 거래에
> 보증금·몰수 문구가 나간다) 하나**다. 반영 뒤 이 파일을 지우고, 플랜 P8의 "리뷰 1·2차 전부 반영" 줄에 3차를 덧붙인다.
> 줄 번호는 `389f541` 기준이다.

## 0. 먼저 읽을 것

- 자금 문제가 아니다. **안내 문구가 틀리게 나간다.** 지정 거래 고지(`DESIGNATED_NOTICE`, "보증금이 없습니다")와 어긋난다.
- 1·2차에서 고친 자리(`shared/src/onchain/progress.ts`, `daemon/src/onchain/notify-messages.ts`)는 맞게 고쳐졌다. 남은 건
  1차 지시서가 확인 범위를 그 두 파일로 좁게 적어 빠진 자리들이다. 새 테스트("모든 상태·역할·환불 사유")도 `progress.ts`만 본다.
- 본보기: `progress.ts`의 `StepAction.designated`(문자열이면 바꾸고, `null`이면 지정 거래에서 뺀다)와
  `OnchainProgressContext.designated`. 같은 방식으로 맞춘다.
- **`docs/RISKS.md`의 R-17 추가와 R-5 한 줄 수정은 이 작업과 별건이다** — 커밋하지 않은 채로 있다. 이 작업 커밋에 섞지 않는다.

## 1. 고칠 자리

### ① 마감 카운트다운의 경고문 — 가장 눈에 띈다

`shared/src/onchain/timing.ts`의 `DEADLINES` 표(`funding`·`presign`·`account`·`krw`)는 `admin`·`mine`·`theirs` 문구가
전부 "…보증금이 몰수됩니다"다. `currentOnchainDeadline(order, viewer)`는 `order`에 `designatedSponsor`를 받지 않아 지정 거래를
가르지 못한다.

- 유저 앱: `customer/src/onchain/components/DeadlineCountdown.tsx`가 마감 1시간 전부터(`remain < 3600`) 빨간 상자에 띄운다.
  사전서명 15분·원화 30분처럼 창이 짧은 마감은 거의 내내 보인다. 파일 머리 주석(4-8행)도 보증금 전제다.
- 어드민: `admin/src/components/OnchainOrderDetail.tsx:51`이 `viewer` 없이 불러 `admin` 문구가 나간다.

고칠 방향: `currentOnchainDeadline`의 `order` 타입에 `designatedSponsor?`를 받고, 지정 거래면 보증금 문장 없이 결과만 말하는
문구를 쓴다(예: "시간 안에 입금이 컨펌되지 않으면 거래가 취소됩니다", "…환불로 넘어갑니다"). `cosign`은 보증금을 말하지 않으니 그대로 둔다.

### ② 계좌 입력 폼 — 지정 온체인 거래는 전부 이 단계를 지난다

`customer/src/onchain/components/AccountInfoForm.tsx:36-37`:
"늦으면 거래가 취소되고 **내 보증금이 몰수됩니다.**" / "틀린 계좌를 주면 상대방이 이의를 내고, 판정에 따라 보증금을 잃을 수 있습니다."
→ 지정 거래면 "늦으면 거래가 환불됩니다" / "틀린 계좌를 주면 상대방이 이의를 내고 운영자가 판정합니다" 쪽으로
(`progress.ts`의 지정 거래 문구와 같은 말로).

### ③ 사전서명 재입력 — 후원자, 클레임 기록이 없는 기기에서

`customer/src/onchain/components/PresignStatus.tsx:32`: "마감을 넘기면 보증금을 잃습니다." → 지정 거래면 "마감을 넘기면 거래가
환불됩니다". 머리 주석(10-12행)도 같이.

### ④ 의뢰 내리기 — 고객, `listed`

`customer/src/onchain/components/CancelOrderPanel.tsx:27`: "이 의뢰를 **오더북에서** 내립니다. **보증금은 그대로 돌려받습니다**" —
지정 거래는 오더북에도 없고 보증금도 없다. → 지정 거래면 "이 의뢰를 내립니다. 아직 상대가 수락하지 않았으니 아무도 손해를 보지
않습니다" 쪽으로. 머리 주석(9행 "상대가 이미 보증금을 걸었으므로")도 지정 거래를 같이 말하게.

### ⑤ 라이트닝 진행 사다리 — `requested` 단계

`shared/src/order-progress.ts:59-75`의 `requested` 단계는 지정 거래에도 다음을 보여 준다(조건부 표시라 덜 틀리지만, 지정 거래에선
보증금이 **절대** 안 붙는다):
- 고객: "후원자가 보증금을 내야 확정됩니다…"
- 후원자: "보증금 인보이스가 오면 결제해야 배정이 확정됩니다… 몰수되고…", 그리고 "'사줄게'를 누르면… **먼저 누른 분에게
  배정됩니다**"(지정 거래는 지정된 사람만, 버튼은 '수락').

`ProgressContext`에 `designated`가 없다. 온체인 `progress.ts`와 같은 방식(`designated` 문맥 + 줄마다 대체/제외)으로 넣고, 사다리를
그리는 곳(`shared/src/components/OrderProgress.tsx`를 부르는 자리)에서 `order.designatedSponsor`로 켠다.

## 2. 이미 확인함 — 다시 파지 않아도 됨

지정 거래에선 안 그려지거나 이미 갈라져 있다:
- `OnchainOrderBook.tsx:109-113`(보증금 인보이스가 있을 때만), `:157-158`(공개 쪽 문구 객체), `OnchainMyOrders.tsx:90-95`(보증금
  결제 대기), `OnchainOrderCard.tsx:127`(보증금 결제 칸), `LnPayPanel.tsx`(보증금 결제 때만) — 지정 거래엔 보증금 인보이스가 없다.
- `OnchainOrderForm.tsx`(모드별로 갈라져 있음), `customer/src/ln/card-view.ts:191`(인보이스 마감 안내 — 처리됨),
  `OnchainMyOrders.tsx:74-76`(대기 문구 — 처리됨).
- 푸시(`notify-messages.ts`)와 온체인 진행 사다리·환불 사유(`progress.ts`) — 처리됨.

확인할 때 쓴 것: `grep -rn "보증금\|몰수" customer/src shared/src admin/src` 후, 각 줄이 지정 거래에서 그려지는지
(`customer/src/onchain/card-view.ts:44-56`의 화면 플래그는 지정 여부를 안 본다).

## 3. 완료 조건

- [ ] ①~⑤ 반영
- [ ] 테스트(프로덕션 경로): ① `currentOnchainDeadline`이 지정 거래면 어느 마감·보는 사람에서도 `보증금`·`몰수`를 안 말하고,
      공개 거래는 그대로 말한다 · ②~④ 지정 온체인 오더로 렌더하면 `보증금`·`몰수`가 없다(`customer/src/tests/designated-render.test.tsx`에
      붙이면 된다) · ⑤ 지정 LN 오더 사다리에 보증금 줄과 "먼저 누른 분"이 없다
- [ ] `pnpm verify`, `pnpm build:customer`·`build:admin` 통과
- [ ] 플랜 P8 줄에 3차 반영을 덧붙이고 이 파일 삭제
- [ ] `docs/RISKS.md`(R-17·R-5)는 건드리지도 커밋하지도 않는다 — 별건
