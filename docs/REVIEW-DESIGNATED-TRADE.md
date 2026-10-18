# 지정 거래 브랜치 코드 리뷰 — 작업 지시서

> **임시 문서.** `feat/designated-trade`(@ `e083151`) 대 `master` 리뷰 결과다. 작업자가 이걸 보고 고친 뒤
> **반영이 끝나면 이 파일을 지운다**(PLAN-DESIGNATED-TRADE.md와 같은 취급). 줄 번호는 `e083151` 기준이라
> 고치다 보면 밀린다 — 함수 이름으로 찾는다.

## 0. 먼저 읽을 것

- 결론: **자금이 잘못 움직이는 버그는 없다.** 고칠 것은 ① 이상한 pubkey 하나로 오더가 영영 안 보이고 무한 재시도하는
  버그, ② 보증금 없는 거래에 "보증금 몰수" 문구, ③ 스팸 경로(설계 판단 필요), 그 밖에 작은 버그와 정리.
- 아직 운영 배포 전(P8 대기)이라 **DB에 남은 나쁜 행은 없다** — 마이그레이션 불필요. 이 브랜치에서 고치고 P8로 간다.
- 리뷰 범위 한계: 정확성 각도 에이전트들이 사용량 한도로 결과를 못 냈고, 정확성은 리뷰 에이전트 1개가 직접 훑었다.
  아래 §5의 "이미 확인함"은 다시 파지 않아도 된다.
- 항목 출처: D1·D2·D3·D4는 코드에서 다시 확인함(D1은 실측). 나머지는 리뷰 에이전트 판단이고 줄 번호만 대조했다.
- 지킬 것(루트 CLAUDE.md): `pnpm verify` + 영향받는 앱 빌드 통과, 테스트는 **프로덕션이 부르는 경로**로, 문구에 숫자 박지
  않기, 공용 문구는 `shared/src/copy.ts`. 이 목록에는 `PROTOCOL_VERSION`을 올릴 변경이 없을 것으로 본다(검증만 조이는
  것이라 한쪽 배포로도 안전) — 모양이나 뜻을 바꾸게 되면 그때 판단.

## 1. 우선순위 한눈에

| ID | 등급 | 한 줄 | 위치 |
|---|---|---|---|
| D1 | **배포 전 필수** | 곡선 밖 pubkey 지정 → 오더 영영 미노출 + 무한 재시도 | `shared/src/designated.ts:30,142`, 두 트랙 publish executor |
| D2 | **배포 전 필수** | 보증금 없는 온체인 지정 거래에 "보증금 몰수" 안내·푸시 | `shared/src/onchain/progress.ts`, `daemon/src/onchain/notify-messages.ts` |
| D3 | **사용자 결정 필요** | 지정 의뢰는 보증금·속도 제한 없음 → 아무 유저에게 푸시·목록 스팸 | `daemon/src/ln/handlers.ts:106`, `daemon/src/onchain/handlers.ts:154` |
| D4 | 작은 버그 | 역할 모를 때 지정 후원자 본인 코드가 "상대 확인 코드"로 | `customer/src/ln/card-view.ts:93-98` |
| D5 | 작은 버그 | 대문자 `NPUB1…`(QR) 거부 | `shared/src/designated.ts:142` |
| D6 | 작은 버그 | 어드민이 재구독마다 지정 스냅샷 전부를 NIP-46으로 재복호화 | `admin/src/daemon/feed.ts:194` |
| D7 | 작은 버그 | `DesignatedOfferCard` 기한 0 미처리, 무시된 수락이 새로고침까지 "보냈습니다" | `customer/src/sponsor/components/DesignatedOfferCard.tsx:37` |
| C1~C12 | 정리 | 동작 영향 없음. D1과 겹치는 C2는 같이 하는 걸 권장 | §4 |

---

## 2. 배포 전 필수

### D1. 곡선 밖 pubkey를 지정하면 오더가 영영 안 보이고 10분마다 무한 재시도

**문제.** 지정 상대 pubkey를 `/^[0-9a-f]{64}$/`로만 본다. secp256k1 x좌표로 올라가지 않는 값도 통과한다.

- `isPubkeyHex` (`shared/src/designated.ts:30`) — `isLnDesignatedOrderPayload`·`isOnchainDesignatedOrderPayload`가 쓴다
  → 앱과 데몬 **양쪽 가드**가 통과시킨다.
- `parsePubkeyInput` (`shared/src/designated.ts:142`) — hex 64자면 그대로 받는다. `checkCode`·`npubEncode`도 이런 값에서
  예외 없이 돈다 → 화면에서 이상 징후가 안 보인다.

**재현(실측).** 무작위 64-hex 200개 중 **92개**가 `nip44.v2.utils.getConversationKey`에서 `bad point` 예외. 고객이 npub
대신 txid·이벤트 id·payment hash를 붙여넣으면 절반 확률로 걸린다.

**흐름.**
1. 데몬 `designatedOrderRequest`(LN, `daemon/src/ln/handlers.ts:106`) / `ocDesignatedOrderRequest`(온체인, `:154`)가 `ok` → 행 삽입.
2. publish executor가 수신자별로 `designatedOrderTemplate` → `nip44Encrypt(..., recipient)`에서 **`.map` 도중 throw**.
   LN `buildOrderEvents` (`daemon/src/ln/effects.ts:220-224`), 온체인 `createOcPublishExecutor` (`daemon/src/onchain/effects.ts:58-62`).
   한 장도 안 나간다(고객·운영자 몫까지).
3. `Effects.runOne` (`daemon/src/effects.ts:124-129`)이 throw를 `retry`로 바꾼다. 두 publish executor 모두
   `maxAttempts`가 없다 → **영원히 재시도.** 종결 상태 발행도 같은 길이라 마찬가지.
4. 결과: 고객은 거절 통지도 없이 오더가 사라진 것처럼 보이고, 운영자도 못 본다. 자금 영향은 없다 — 곡선 밖 키는
   서명할 수 없어서 아무도 클레임 못 하고, 그러면 펀딩도 일어나지 않는다.

**수정 방향.**
- shared에 **점 검사** 하나를 둔다(x-only lift 가능 여부 — `@noble/curves`의 schnorr `lift_x` 또는
  `Point.fromHex('02' + hex)`. 설치된 버전의 API를 확인할 것. 온체인 서명 경로의 `@noble/curves` 핀은 건드리지 않는다).
- `isPubkeyHex`가 그걸 쓰게 한다 → 두 페이로드 가드가 같이 조여진다(데몬은 `ignored('bad-payload')`).
- `parsePubkeyInput`도 점 검사 실패면 `null` → 입력 칸에서 "못 읽음"으로 끝난다.
- executor 방어: 결정적 실패(암호화 불가)는 재시도해도 안 낫는다. 수신자별로 감싸서 **그 수신자만 빼고** 나머지는 내거나,
  `dead` + `raiseAlert`로 운영자에게 알린다. **`maxAttempts`를 일괄로 붙이지는 말 것** — 릴레이 장애 재시도까지 끊긴다.
- C2(발행 코드 중복 합치기)를 먼저 하면 이 방어를 한 곳에만 넣으면 된다.
- 겹치는 정리: `isPubkeyHex`가 `isXonlyHex`(`shared/src/onchain/hex.ts:31`)와 같은 일을 한다 — 하나로.

**완료 조건.**
- 데몬 테스트(실제 dispatch 하네스): 곡선 밖 hex를 지정한 요청 → LN·온체인 둘 다 무시/거절, 행 없음.
- executor 테스트: 수신자 하나가 암호화 불가여도 무한 `retry`로 남지 않음.
- shared 테스트: `parsePubkeyInput('<곡선 밖 hex>') === null`, 정상 hex·npub·nprofile은 그대로 통과.

### D2. 보증금 없는 온체인 지정 거래에 "보증금이 몰수됩니다" 안내·푸시가 나감

**문제.** 온체인 진행 문구와 푸시에 지정 거래 분기가 없다. 지정 거래는 `customerDepositHash`·`sponsorDepositHash`가
없는데도 몰수를 고지한다. 앱의 지정 고지(`DESIGNATED_NOTICE` — "보증금이 없습니다")와 정면으로 어긋난다.

- 환불 사유: `refundingInfo` (`shared/src/onchain/progress.ts:284-297`). `refund:sponsor-timeout`은 "상대방/내 보증금은
  몰수됐습니다", `refund:customer-late`도 몰수 문구. 둘 다 지정 거래에서 도달 가능하다.
- 단계 안내: 같은 파일 `:102`, `:120`, `:130` ("늦으면 … **내 보증금이 몰수됩니다.**").
- 푸시: `ONCHAIN_NOTIFY.customerShouldFund` (`daemon/src/onchain/notify-messages.ts:37` — "늦으면 보증금이 몰수됩니다").

**수정 방향.**
- 진행 문맥에 "지정 거래"(보증금 없음)를 싣고, 위 문구들이 지정 거래에선 몰수 대신 결과만 말하게 한다
  (예: "마감 안에 … 않아 거래가 환불됩니다"). 공개 거래 문구는 그대로 — "몰수의 조건은 반드시 고지한다" 원칙은
  보증금이 있을 때 얘기다.
- `progress.ts`·`notify-messages.ts`에서 `보증금`을 grep해 지정 거래에서 도달 가능한 줄을 **전부** 확인한다.
  LN 쪽(`shared/src/ln/`, `daemon/src/ln/notify*.ts`)도 같은 기준으로 한 번 훑는다(리뷰에선 LN엔 몰수 알림이 없다고 봤다).
- `refund:reserve`의 "양쪽 보증금은 돌려받습니다"처럼 보증금을 전제한 다른 문구도 같이 본다.

**완료 조건.** 지정 온체인 오더(`designatedSponsor` 있음)로 진행 요약·환불 안내·푸시 문구를 뽑는 테스트에 `몰수`·`보증금`이
안 나온다. 공개 오더 문구는 기존 테스트 그대로 통과.

---

## 3. 사용자 결정 필요

### D3. 지정 의뢰는 보증금·속도 제한이 없다 — 아무 유저에게 푸시·목록 스팸 가능

> **작업자: 방향이 정해지기 전에는 구현하지 말고**, 최소한 `docs/RISKS.md`의 R-16에 이 경로를 적는다.

**사실관계(코드 확인).** 영향은 어드민에만 가는 게 아니다.
- LN `designatedOrderRequest`는 초안·고객 보증금을 거치지 않고 바로 `insertOrder` → 운영자 전원 DM
  (`daemon/src/ln/store.ts:86-87`) → `notifyDesignatedArrived` → **지정된 pubkey에게 웹 푸시**
  (`daemon/src/ln/notify.ts:77-80`, "회원님을 상대로 지정한 거래가 도착했습니다"). dedup은 오더 id 단위라 오더마다 새로 간다.
- 그 오더는 피해자 앱 사주기 탭의 **"나를 지정한 거래" 목록**에 뜬다(`customer/src/sponsor/components/OrderBook.tsx:22-31`).
- 온체인도 같다(`ocDesignatedOrderRequest` → `notifyOcDesignatedArrived`, `daemon/src/onchain/notify.ts:53`). 관문이
  `acceptNewOrders`·최소액·수수료 조회뿐이고 보증금·속도 제한은 없다.
- 운영자가 스팸 막으려고 `customerDepositPct`를 켜도 지정 거래는 우회한다. 어드민의 `depositWarnings` 문구는
  고객 보증금이 오더북 스팸을 막는다고 안내하고 있다.
- 피해 대상은 이 앱에 푸시를 등록한 유저이고, 공격자는 그 pubkey를 알아야 한다. 거래한 적 있으면 공개 오더 이벤트에 pubkey가 남는다.
- D1과 겹치면 곡선 밖 지정 오더를 대량으로 넣어 무한 재시도 효과 행을 쌓을 수 있다(D1을 고치면 사라진다).

**선택지(가벼운 순).**
1. 감수 + RISKS R-16 기재.
2. 고객 pubkey당 **열린 지정 오더 개수 상한**(예: N개). 정상 사용엔 거의 안 걸리고 구현이 작다.
3. 지정 대상 pubkey당 도착 푸시를 묶기(시간창 dedup) — 푸시 폭탄만 막는다. 목록 스팸은 남는다.
4. 고객 보증금 설정이 켜져 있으면 지정 거래에도 적용 — "보증금 없는 1:1"이라는 기능 취지와 충돌한다.

---

## 4. 작은 버그 · 정리

### 작은 버그

**D4. 역할을 모를 때 지정 후원자 본인 코드가 "상대 확인 코드"로 뜬다** — `designatedOf` (`customer/src/ln/card-view.ts:93-98`).
`role === 'sponsor' ? order?.customerPubkey : sponsor` → `role`이 null이면 지정 후원자를 상대로 친다. 주석은 "내 역할을
모르면 지정 사실만"이다. 경로: 지정 후원자가 수락 → IDB 보관 → 데몬이 클레임을 무시하거나 운영자가 되돌림
(`daemon/src/ln/commands.ts:45`) → 다시 `requested`·`sponsorPubkey` 없음 → `LnOrderDetail`이 `archived`라 `relation` null
(`LnOrderDetail.tsx:39`) → `LnOrderCard`가 내 코드를 "상대 확인 코드"로 표시하고, 다시 수락할 길도 없다.
수정: `role === null`이면 `{ counterpartyCode: '' }`. `LnOrderCard.tsx:176`이 빈 코드일 때 "지정 거래 · 보증금 없음"만
보이게 한다(지금은 빈 `<b>`가 찍힌다). 온체인 카드(`OnchainOrderCard.tsx:92`)도 같은 경우가 있는지 본다.
같이 볼 것: 같은 함수의 `order?.designatedSponsor ?? local?.designatedSponsor`는 고객 본인 기록보다 데몬 값을 먼저 쓰고,
`:141`의 에스크로 `pay`는 `order.sponsorPubkey === 지정 상대`를 대조하지 않는다. 데몬이 클레임에서 이미 막는다
(`handlers.ts` `claim`의 `not-designated`). 그래서 이건 앱 쪽 이중 확인(T-107 정신)으로 **선택**이다.

**D5. 대문자 `NPUB1…` 거부** — `parsePubkeyInput` (`shared/src/designated.ts:142`). 접두 검사 `/^(npub1|nprofile1)/`가
대소문자를 가린다. QR 영숫자 모드는 대문자 bech32를 만든다. 수정: 접두 검사를 `i`로, `decode`에는 소문자로 바꾼 값을
넘긴다(bech32는 대소문자 혼용만 금지).

**D6. 어드민 재구독마다 NIP-46 복호화 폭주** — `onDesignatedEvent` (`admin/src/daemon/feed.ts:194-199`). `since: epoch`라
재구독(탭 가시성 변경 등)마다 보존 중인 지정 스냅샷이 전부 재생되고, 매번 `signer.nip44Decrypt`를 부른다. 그 뒤 `upsertOrder`가
오래된 걸 버린다. N개면 원격 서명기 요청 N번이라 승인 창이 N개 뜰 수 있다. 수정: 평문 `d` 태그(`orderId:recipient`)로 orderId를
읽어 **저장된 오더의 `updatedAt >= event.created_at`이면 건너뛰기**, `expiration` 지났으면 건너뛰기(`onLnDetailEvent`가 하는 방식).

**D7. `DesignatedOfferCard` 두 가지** (`customer/src/sponsor/components/DesignatedOfferCard.tsx`).
- `:37` `order.expiration - now < 3600`에 `expiration > 0` 가드가 없다(`OrderCard`는 0이면 '기한 없음'). 지금은 호출부가
  `isClaimableLn`으로 미리 걸러서 안 터진다. 회색 값도 `OrderCard`와 다르다 → C8과 같이.
- LN 수락이 데몬에서 무시되면 새로고침 전까지 '수락을 보냈습니다'에 머문다.

### 정리 (동작 영향 없음)

- **C1. 문구의 "5%" 하드코딩** — `OnchainOrderForm.tsx:179`. 규칙은 데몬에만 있는 `DESIGNATED_MIN_FEE_MULTIPLE = 20`
  (`daemon/src/onchain/deposit.ts:88`, 사용 `daemon/src/onchain/handlers.ts:175`). 상수를 `shared/src/onchain`으로 옮기고
  문구는 `100 / multiple`로 만든다. 데몬 주석(`handlers.ts:177`)도.
- **C2. 수신자별 스냅샷 발행이 두 벌** — `daemon/src/ln/effects.ts:217-244`와 `daemon/src/onchain/effects.ts:55-70`가 거의 같다
  (수신자 규칙 `new Set([customer, designated, ...operators])`, 템플릿·서명, "하나라도 실패면 retry"). 헬퍼 하나로 합친다
  (스냅샷 만들기 + `publishAll(transport, events) → EffectOutcome`). **D1의 executor 방어를 여기에 한 번만** 넣는다.
- **C3. O-015 면제가 두 가드에 따로** — `daemon/src/onchain/decide.ts:186,194`의 `!order.designatedSponsor &&`. 앞으로
  `ctx.sponsorBondAlive`를 보는 검사가 이 접두를 빠뜨리면 지정 거래가 "무한 보류"로 돌아간다. `bondAlive`를 한 번만 유도하거나
  출처(`daemon/src/onchain/watcher.ts:151,172`)에서 지정 거래면 `true`로 준다.
- **C4. 복호화 헬퍼 중복과 분류 불일치** — LN `designatedOrderRequest`(`daemon/src/ln/handlers.ts:111`)와 `:281`은 인라인
  `JSON.parse(nip44Decrypt(...))`, 온체인은 `decrypt`(`daemon/src/onchain/handlers.ts:58`). 같은 깨진 암호문을 LN은
  `ignored:undecryptable`, 온체인은 `ignored:bad-payload`로 기록한다(테스트가 둘 다 단언). `dispatch.ts`에 `decryptRequest` 하나.
  앱 쪽도 `restoreDesignatedOrderRequest`(`customer/src/nostr/own-requests.ts:60`)와 `decryptToApp`
  (`customer/src/onchain/nostr/own-requests.ts:20`)가 중복이다. 분류를 바꾸면 테스트 기대값도 같이 바꾼다.
- **C5. 지정 구독이 소켓 풀을 따로 연다** — `subscribeDesignatedOrders` (`customer/src/nostr/subscribe.ts:97-104`)가
  `createSubscriptionPool()`을 새로 만든다. 트랙마다 릴레이 수만큼 소켓이 더 열리고 재시작마다 재연결된다. 기존 풀을 받게 한다.
- **C6. 오더북 이중 구독·이중 타이머** — `OrderBook`(`customer/src/sponsor/components/OrderBook.tsx:18-21`)과 `PublicBook`(`:39-46`)이
  같은 스토어·`useMyPubkey`·`useNow`를 각자 부른다. 1초 타이머 두 개, 두 목록이 서로 다른 `now`로 `isClaimableLn`을 평가할 수 있다.
  `orders`/`myPubkey`/`now`를 props로 내린다.
- **C7. `ClaimForm`의 모드 삼항 8곳** — `customer/src/onchain/components/OnchainOrderBook.tsx:151-304`. `:297-299`는 문장을 두 조각으로
  따로 골라 붙인다. 모드별 문구 객체 하나 + `blocked = designated && !consentGiven(consent)` 한 번.
- **C8. `DesignatedOfferCard`가 `OrderCard`를 복사** — 카드 틀·가격/남은 시간 머리·스타일이 이미 어긋났다(D7). 머리 컴포넌트·스타일 공유.
- **C9. 지정 거래 문구 중복** → `shared/src/copy.ts`(`DESIGNATED_NOTICE` 옆):
  검증 메시지 '상대 주소를 넣고 확인 코드 대조와 위험 고지를 체크해 주세요.'(`OrderForm.tsx:45`, `OnchainOrderForm.tsx:80`),
  버튼 '지정 거래 만들기'(`OrderForm.tsx:134`, `OnchainOrderForm.tsx:192`), '… 확인 코드 … · 보증금 없음' 줄(`LnOrderCard.tsx:176`,
  `OnchainOrderCard.tsx:92`).
- **C10. '지정 거래' 배지 스타일 중복·불일치** — `LnOrderCard.tsx:283`(padding `2px 8px`, radius 6) vs
  `customer/src/onchain/components/card-styles.ts:10`(`2px 6px`, radius 4). 같은 배지가 트랙마다 다르게 보인다.
  `customer/src/ui.ts`에 하나. 어드민(`admin/src/components/OrderLists.tsx:112`)은 customer ui를 못 가져가니 따로 두거나 shared로.
- **C11. `publish.designated`가 `view.designated`와 중복** — 하나로.
- **C12. 온체인 핸들러의 `customerXonly!` 단언** — `daemon/src/onchain/handlers.ts:144`. 흐름상 안전하더라도 단언 대신 좁히기로.

---

## 5. 이미 확인함 — 다시 파지 않아도 됨

- **후원자 인보이스가 새 6시간 마감과 경합?** 없음. 핸들러가 `escrowed → invoiced`를 동기로 옮긴다(`daemon/src/ln/handlers.ts:184-186`).
- **`escrowed`에서 `invoice_deadline`이 null?** 불가. `escrowed`로 들어오는 전이는 `onEscrowAccepted`의 `verified → escrowed` 하나고 거기서 세팅한다.
- **가짜 오더 이벤트의 `sig: ''`?** 재검증하는 곳이 없다.
- **지정 오더에 NIP-69 태그 누락?** 두 파서 모두 기본 태그만 읽는다. 온체인은 `network`를 스스로 다시 붙인다.
- **어드민 비동기 복호화가 순서 뒤바뀌어 적용?** 안전. `upsertOrder`가 `updatedAt` 큰 쪽을 남긴다.
- **LN 지정 거래에 몰수 알림 오발?** LN엔 몰수 알림 자체가 없다.
- 컨벤션 통과: `PROTOCOL_VERSION` 2로 올림, `expiration` 태그(스냅샷·LN/온체인 지정 요청), 데몬은 `/core`·`/ln`만 import,
  저장소 가드(`isStoredLnOrder`·`isStoredOnchainOrder`)가 새 선택 필드 포함(값 뜻이 안 바뀌어 version 불필요),
  ErrorBoundary 범위, `void` 핸들러 패턴, LN-TRACK 표의 `INVOICE_WINDOW_SEC`와 timing-invariants, 닫기 사유
  `expired:no-invoice`(master에 이미 있음), 데몬 테스트가 실제 dispatch 하네스를 탐.

## 6. 끝내기 체크

- [ ] D1·D2 반영 + 위 완료 조건 테스트
- [ ] D3: 사용자 결정 반영(최소 RISKS R-16 기재)
- [ ] D4~D7, C1~C12 중 반영한 것 표시
- [ ] `pnpm verify` 통과, `pnpm build:customer`·`build:admin`·`build:daemon` 통과
- [ ] 문구·규칙이 바뀐 곳은 트랙 문서(ONCHAIN-TRACK·LN-TRACK)·RISKS 동기화
- [ ] 이 파일 삭제
