# TODO - 사줘 트래커

향후 구현해야 할 기능 및 개선 사항 목록

## Customer App

### 결제 관련

- [ ] **부분 결제 처리**: 쿠폰으로 일부 결제된 경우 (`payedPayment.couponPayment`) 금액 표시 개선
  - 현재: `depositPrice` (실제 입금해야 할 금액)만 저장
  - 고려: 총 주문금액, 쿠폰 할인액, 실입금액 모두 표시할지 결정 필요

- [ ] **입금 기한 만료 처리**: `expirationDate` 지나면 자동으로 `cancelled` 상태 전이
  - Background script에서 주기적으로 체크
  - 알림 기능 추가

- [ ] **입금 완료 자동 감지 개선**: 현재 페이지 방문 시에만 감지됨
  - Background script에서 주기적으로 API 호출하여 상태 확인
  - 또는 쿠팡 알림 페이지 모니터링

- [ ] **주문 취소 자동 감지 개선**: 현재 페이지 방문 시에만 감지됨
  - 입금 완료와 동일하게 Background script에서 주기적으로 확인
  - 취소 감지 시 `cancelled` 전이 + Nostr에 `sold` 상태로 재발행

### 상태 관리

- [ ] **claimed 상태 타임아웃**: 일정 시간 내 `selected`로 진행 안 하면 자동 해제
  - `claimedAt` 필드 활용
  - 타임아웃 시 `requested` 상태로 복귀

- [ ] **다중 클레이머 관리**: 여러 명이 claim한 경우 목록 관리
  - 현재: 단일 `claimedBy` 필드
  - 개선: 클레이머 목록으로 확장 고려

### UI/UX

- [ ] **알림 기능**: 상태 변경 시 Chrome 알림
  - claim 요청 수신 시
  - 입금 완료 시

## Sponsor App

- [x] **"사줄게" 클레임 기능**: kind 1111 (NIP-22 Comment)로 클레임 이벤트 발행
  - a-tag으로 원본 30402 리스팅 참조
  - 로컬 상태 관리 (detected → claimed FSM)
- [ ] **오더북 페이지네이션**: 주문이 많아질 경우 대비
- [ ] **계좌 정보 수신**: 선택(selected) 시 무통장입금 계좌 정보 수신 및 표시 (DM 등)
- [ ] **Lightning invoice 제출**: 클레임 시 주문 금액 상당의 invoice를 생성하여 클레임 이벤트에 포함
  - 어드민이 probing으로 유동성 검증하는 데 사용
  - invoice는 kind 1111 이벤트의 content 또는 태그로 전달
- [ ] **스타일링 고도화**: 현재 인라인 스타일 → CSS 또는 스타일링 라이브러리

## Admin App (에스크로 서비스)

- [x] **CLI 테스트 도구**: 랜덤 이벤트 발행 (`admin:emit`), sold 업데이트 (`admin:sold`)
- [x] **웹앱 클레임 대기열**: kind 1111 클레임 + kind 30402 주문 구독, 승인/거절 UI
- [ ] **클레임 유동성 검증**: Sponsor 클레임의 invoice에 대해 probing 수행
  - 랜덤 payment hash로 경로 탐색 (실제 결제 없음, 수수료 없음)
  - probing 성공 (`INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS`): Customer에 클레임 전달
  - probing 실패 (`TEMPORARY_CHANNEL_FAILURE` 등): Sponsor에 거절 통보
  - `LightningProber` 인터페이스 + LND/CLN 어댑터 패턴으로 구현체 교체 가능하게
  - LND: gRPC `SendPaymentV2` + 랜덤 hash / CLN: `getroute` + `sendpay`
  - `.env`로 구현체 선택 (`LIGHTNING_IMPL=lnd|cln`) + 엔드포인트/인증 정보 관리
- [ ] **에스크로 관리**: 거래 진행 중 BTC 에스크로 보관 및 조건 충족 시 릴리스
- [ ] **릴레이 목록 관리**: kind 10002 이벤트 발행/수정 UI
- [ ] **모니터링 대시보드**: 시스템 전체 현황 파악 (`#p` 필터로 모든 이벤트 조회)
- [ ] **분쟁 해결 도구**: 문제 발생 시 중재 기능

## 기술 부채

- [ ] **테스트 코드 작성**: state-machine, filter 등 핵심 로직 테스트
- [ ] **에러 처리 강화**: 네트워크 오류, 파싱 실패 등 예외 상황 처리
- [ ] **로깅 개선**: 디버깅 용이하도록 구조화된 로그

---

**Last Updated**: 2026-02-14
