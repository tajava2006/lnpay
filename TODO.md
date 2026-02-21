# TODO - 사줘 트래커

향후 구현해야 할 기능 및 개선 사항 목록

## Customer App

### 결제 관련

- [ ] **부분 결제 처리**: 쿠폰으로 일부 결제된 경우 (`payedPayment.couponPayment`) 금액 표시 개선
  - 현재: `depositPrice` (실제 입금해야 할 금액)만 저장
  - 고려: 총 주문금액, 쿠폰 할인액, 실입금액 모두 표시할지 결정 필요

- [ ] **입금 기한 만료 처리**: `expirationDate` 지나면 UI에서 만료 표시
  - Admin이 릴레이에서 만료 이벤트 자동 처리하므로 로컬 상태 전이 불필요
  - UI에서 만료 시간 경과 시 시각적 표시 + 알림 기능 추가

- [ ] **입금 완료 자동 감지 → `payment-confirm` 전송**: 현재 페이지 방문 시에만 감지됨
  - Background script에서 주기적으로 쿠팡 API 호출하여 상태 확인
  - 입금 감지 시 `SEND_REQUEST` + `action: 'payment-confirm'`으로 Admin에 통보

- [ ] **주문 취소 자동 감지 → `cancel-request` 전송**: 현재 페이지 방문 시에만 감지됨
  - Background script에서 주기적으로 쿠팡 API 확인
  - 취소 감지 시 `SEND_REQUEST` + `action: 'cancel-request'`로 Admin에 통보
  - Admin은 만료 전이라도 즉시 취소 처리 가능

### 로컬 FSM 정리 (Phase 1 후속) — 완료

- [x] **로컬 FSM 전면 제거**: `state-machine.ts` 삭제, `OrderStatus`/`ALLOWED_TRANSITIONS`/`TransitionResult` 등 제거
  - `TrackedOrder`에서 `status`, `version`, `claimedBy`, `claimedAt` 필드 제거
  - `raw` 필드 존재 여부로 "요청 전송됨" 판단, 이후는 `adminState` 그대로 표시
  - `order-states.ts`를 `adminState` + `raw` 기반 `getDisplayMeta(order)` / `isFinal(order)` / `isDeletable(order)`로 전면 재작성
- [x] **PUBLISH_ORDER → SEND_REQUEST 전환**: `action: RequestAction` 필드 추가로 향후 `payment-confirm`, `cancel-request` 등 확장 가능
- [x] **order-states.ts 미사용 함수 삭제**: `getStatusLabel()`, `getStatusCssClass()`, `getStatusStyle()`, `getActiveStatuses()` 전부 제거

### UI/UX

- [ ] **알림 기능**: 상태 변경 시 Chrome 알림
  - Admin 오더 상태 변경 수신 시 (claimed, verified, escrowed, paid 등)
  - 입금 완료 시

## Sponsor App

- [x] **"사줄게" 클레임 기능**: kind 1111 (NIP-22 Comment)로 클레임 이벤트 발행
  - a-tag으로 Admin의 kind 30402 오더 참조
  - Admin이 상태 변경 → Sponsor는 갱신된 오더를 구독하여 표시
- [ ] **오더북 페이지네이션**: 주문이 많아질 경우 대비
- [ ] **계좌 정보 수신**: Admin이 verified 이후 무통장입금 계좌 정보 전달 (DM 등)
- [x] **Lightning invoice 제출**: 클레임 시 bolt11 invoice를 붙여넣고 형식 검증 후 클레임 이벤트에 `['bolt11', invoice]` 태그로 포함
- [x] **유동성 검증 invoice 금액 자동 환산**: BTC 실시간 가격 기반으로 주문 KRW 금액을 BTC로 환산하여 invoice 금액 가이드 표시
  - PriceTracker 연동, 90~110% 범위 검증
- [ ] **스타일링 고도화**: 현재 인라인 스타일 → CSS 또는 스타일링 라이브러리

## Admin App (에스크로 서비스)

- [x] ~~**CLI 테스트 도구**~~: 제거됨 — Customer Dev 패널로 대체
- [x] **요청 대기열**: kind 1111 요청 수신 (order-request, claim) + kind 30402 오더 발행/관리, 승인/거절 UI
- [x] **통합 FSM**: Admin 단일 상태 머신 (`requested → claimed → verified → escrowed → paid`, `rejected`/`cancelled` 분기)
- [x] **kind 30402 오더 발행**: order-request 수신 시 자동 오더 생성, 상태 전이 시 갱신 발행
- [ ] **payment-confirm / cancel-request 핸들러**: Customer가 쿠팡에서 입금완료/취소를 감지하면 kind 1111로 통보함
  - 현재: request-store에 저장만 되고 처리 로직 없음 (`admin/src/nostr/service.ts`에서 `order-request`만 분기)
  - `payment-confirm` 수신 시: escrowed 상태 오더에 대해 입금 확인 플래그 표시 또는 자동 전이
  - `cancel-request` 수신 시: 해당 오더를 cancelled로 전이 (진행 중인 에스크로가 아닌 경우)
- [x] **Lightning 노드 연결**: LND/CLN 어댑터 패턴, 브라우저에서 직접 LN REST API 호출
  - `LightningAdapter` 인터페이스 (getInfo, decodeInvoice, probe)
  - LND: `GET /v1/getinfo` + macaroon 인증 / CLN: `POST /v1/getinfo` + rune 인증
  - NodeTracker (30초 polling) + NodeStatus 헤더 인디케이터
  - nginx 리버스 프록시(Let's Encrypt)를 통해 self-signed TLS 문제 해결
- [x] **클레임 유동성 검증**: Sponsor 클레임의 invoice에 대해 probing 수행
  - `bolt11` 패키지로 인보이스 디코딩 (destination, amount, route hints 추출)
  - 랜덤 payment hash로 경로 탐색 (실제 결제 없음, 수수료 없음)
  - probing 성공 (`INCORRECT_PAYMENT_DETAILS`): 유동성 존재 확인
  - probing 실패 (`NO_ROUTE`, `TIMEOUT` 등): 유동성 부족
  - LND: `/v2/router/send` + 랜덤 hash / CLN: `getroute` + `sendpay`/`waitsendpay`
- [x] ~~**Vite dev 서버 LN 프록시**~~: 제거됨 — 브라우저에서 직접 LN REST 호출로 전환

### 순수 프론트엔드 전환 (진행 중)

- [ ] **NIP-46 인증**: `.env` 기반 `APP_SECRET_KEY` 제거 → NIP-46 원격 서명자 연동
  - 개인키가 브라우저에 노출되지 않음 (nsecBunker 등에 위임)
  - `/__admin_config` Vite dev 미들웨어 의존성 완전 제거
- [ ] **암호화된 LN 설정 저장소**: `VITE_LN_*` 환경변수 제거 → Nostr 릴레이에 암호화 저장
  - LN URL, 인증정보(macaroon/rune), 구현체 종류를 릴레이에 암호화하여 저장
  - 앱 시작 시 NIP-46 인증 후 복호화하여 메모리(React 상태)에서만 유지
  - 프로덕션 빌드에 민감 정보 미포함 → 정적 SPA로 자유롭게 배포 가능

### 저장소 이중화 (Phase 2~3)

- [x] **localStorage 삭제 전략 단순화 (Phase 2)**: 만료 오더 + 연관 요청 공격적 삭제
  - Admin: `cleanup.ts` 스케줄러가 order-store + request-store 연쇄 삭제 (60초 주기)
  - Sponsor: `order-store.ts` 내장 스케줄러로 만료 오더 삭제 (60초 주기)
  - 삭제 기준: `expiration > 0 && expiration <= now` (상태 무관)
- [ ] **IndexedDB 도입 (Phase 3)**: 에스크로 책임이 있는 오더의 영구 저장
  - `orders` + `requests` 오브젝트 스토어
  - 에스크로 진입 시점에 localStorage → IndexedDB 이동
  - 히스토리 UI (커서 기반 페이지네이션, 상태 필터)
  - 상세 설계: STORAGE-STRATEGY.md 섹션 6 참조

### 기타

- [ ] **에스크로 관리**: Hold invoice로 Customer BTC 에스크로
  - Admin이 hold invoice 생성 (프리이미지 보유 = settle 권한)
  - Customer가 hold invoice 결제 → BTC가 HTLC에 잠김
  - KRW 입금 확인 후 Admin이 settle → BTC 수령 → Sponsor에게 전송
  - 문제 발생 시 settle 안 함 → CLTV timeout 후 Customer에게 자동 환불
  - `LightningEscrow` 인터페이스로 LND/CLN 구현체 독립
  - LND: `AddHoldInvoice` + `SettleInvoice` / CLN: `invoice` (hold) + `holdinvoice` 플러그인
- [ ] **릴레이 목록 관리**: kind 10002 이벤트 발행/수정 UI
- [ ] **모니터링 대시보드**: 시스템 전체 현황 파악
- [ ] **분쟁 해결 도구**: 문제 발생 시 중재 기능

## 스팸/DoS 차단

### Customer 스팸 차단

- [ ] **Fidelity bond**: order-request 발행 시 주문 금액의 일부를 hold invoice로 선납
  - BTC가 없는 스패머 원천 차단 (어차피 Customer가 지불할 금액이므로 추가 비용 아님)
  - 정확한 금액이 아닌 보증 목적의 소액 (BTC 가격 변동 대응)
  - 클레이머 확정 + 유동성 검증 통과 시 fidelity bond cancel (즉시 환불)
  - 해당 시점의 정확한 BTC/KRW 환율로 본 hold invoice 재발행
  - Cancel 시 라우팅 수수료 포함 전액 환불 (HTLC 미settle = 중간 노드 수수료 없음)
  - 취소-재발행 윈도우에 Customer 이탈 가능하나 Sponsor 손해 없음

### Sponsor 스팸 차단

- [ ] **Lightning 노드 블랙리스트**: invoice의 destination node pubkey로 Sponsor 식별
  - Nostr pubkey는 무료 생성 가능 → 식별 수단 부적합
  - Lightning 노드는 채널 펀딩(실제 BTC)이 필요 → Sybil 비용 높음
  - 트롤링 발생 시 (클레임 후 KRW 미입금 등) 해당 노드 블랙리스트 등록
  - Admin 웹앱에서 블랙리스트 관리 UI
- [ ] **Sponsor fidelity bond (향후 필요 시)**: 커스토디얼 월렛 악용 대응
  - 커스토디얼 유저는 공유 노드 사용 → 의도적 차단 유도 공격 가능
  - RoboSats 방식: 주문 금액의 ~3%를 hold invoice로 보증금 수령
  - 거래 정상 완료 시 전액 반환, 트롤링 시 몰수
  - 초기에는 소규모 신뢰 기반 운영이므로 블랙리스트만으로 충분, 규모 확장 시 검토

## BTC 가격 활용

- [x] **BTC/KRW 실시간 가격 표시**: 업비트/빗썸/코인원 WebSocket으로 3개 앱 헤더에 실시간 가격 표시
- [ ] **결제 금액 실시간 BTC 환산**: Customer 대시보드에서 주문 금액 옆에 BTC 환산 표시
  - PriceTracker의 가격 데이터 활용 (Sponsor 오더북은 이미 구현됨)

## 기술 부채

- [ ] **테스트 코드 작성**: Admin state-machine, Customer/Sponsor 이벤트 파싱 등 핵심 로직 테스트
- [ ] **에러 처리 강화**: 네트워크 오류, 파싱 실패 등 예외 상황 처리
- [ ] **로깅 개선**: 디버깅 용이하도록 구조화된 로그

---

**Last Updated**: 2026-02-22
