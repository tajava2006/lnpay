# TODO - 사줘 트래커

미구현 기능 및 개선 사항 목록

## Customer App

### 결제 관련

- [ ] **부분 결제 처리**: 쿠폰으로 일부 결제된 경우 (`payedPayment.couponPayment`) 금액 표시 개선
  - 현재: `depositPrice` (실제 입금해야 할 금액)만 저장
  - 고려: 총 주문금액, 쿠폰 할인액, 실입금액 모두 표시할지 결정 필요

- [ ] **입금 기한 만료 처리**: `expirationDate` 지나면 UI에서 만료 표시
  - Admin이 릴레이에서 만료 이벤트 자동 처리하므로 로컬 상태 전이 불필요
  - UI에서 만료 시간 경과 시 시각적 표시 + 알림 기능 추가

- [ ] **입금/취소 자동 감지 주기적 폴링**: 현재 유저스크립트가 쿠팡 페이지 방문 시에만 감지
  - 유저스크립트에서 주기적 API 폴링 또는 Service Worker 활용 고려
  - 페이지 방문 없이도 상태 변화 감지 가능하도록 확장

### UI/UX

- [ ] **알림 기능**: 상태 변경 시 브라우저 알림
  - Admin 오더 상태 변경 수신 시 (claimed, verified, escrowed, paid 등)
  - 입금 완료 시

## Sponsor App

- [ ] **오더북 페이지네이션**: 주문이 많아질 경우 대비
- [x] **히스토리 UI**: IndexedDB에 저장된 클레임 히스토리를 보는 별도 화면
- [ ] **스타일링 고도화**: 현재 인라인 스타일 → CSS 또는 스타일링 라이브러리

## Admin App (에스크로 서비스)

### 저장소 이중화

- [x] **히스토리 UI**: IndexedDB 데이터를 보는 별도 화면
  - 커서 기반 페이지네이션 (`[state, createdAt]` 복합 인덱스 활용)
  - 상태 필터 지원

### 정산 (BTC 지급/환불)

- [ ] **bolt11 만료 시 처리**: 후원자의 원본 bolt11이 만료된 경우, 동일 sat 금액의 새 인보이스를 요청하는 메커니즘 필요
- [ ] **고객 승리 → 고객에게 BTC 환불**: 만료 임박 선제 settle로 hold invoice가 이미 settle된 경우, 별도 LN 결제로 고객에게 반환
  - 고객의 LN 수신 인보이스를 받는 메커니즘 필요

### 기타

- [ ] **릴레이 목록 관리**: kind 10002 이벤트 발행/수정 UI
- [ ] **모니터링 대시보드**: 시스템 전체 현황 파악
- [x] **분쟁 해결 도구**: `remitted` 상태의 오더에 대한 Admin 중재 기능
  - kind 1111 `dispute-message` + NIP-44 암호화 채팅 구현
  - Admin ↔ Customer, Admin ↔ Sponsor 1:1 채팅
  - 분쟁 판정: `sponsor_wins` (hold invoice settle + BTC 전송) / `customer_wins` (hold invoice cancel + BTC 환불)
  - Sponsor 계좌정보 공개 + Admin 커밋먼트 SHA-256 검증 배지
  - IDB 채팅 메시지 영구 보존 (메인 구독에서 자동 저장)
  - 히스토리 UI + 오더 상세 페이지 (Admin/Sponsor/Customer 모두)

## 스팸/DoS 차단

### Customer 스팸 차단

- [ ] **Fidelity bond**: order-request 발행 시 주문 금액의 일부를 hold invoice로 선납
  - BTC가 없는 스패머 원천 차단 (어차피 Customer가 지불할 금액이므로 추가 비용 아님)
  - 정확한 금액이 아닌 보증 목적의 소액 (BTC 가격 변동 대응)
  - 클레이머 확정 + 유동성 검증 통과 시 fidelity bond cancel (즉시 환불)
  - 해당 시점의 정확한 BTC/KRW 환율로 본 hold invoice 재발행

### Sponsor 스팸 차단

- [ ] **Lightning 노드 블랙리스트**: invoice의 destination node pubkey로 Sponsor 식별
  - Nostr pubkey는 무료 생성 가능 → 식별 수단 부적합
  - Lightning 노드는 채널 펀딩(실제 BTC)이 필요 → Sybil 비용 높음
  - 트롤링 발생 시 해당 노드 블랙리스트 등록, Admin 웹앱에서 관리 UI
- [ ] **Sponsor fidelity bond (향후 필요 시)**: 커스토디얼 월렛 악용 대응
  - RoboSats 방식: 주문 금액의 ~3%를 hold invoice로 보증금 수령

## BTC 가격 활용

- [ ] **결제 금액 실시간 BTC 환산**: Customer 대시보드에서 주문 금액 옆에 BTC 환산 표시

## 기술 부채

- [ ] **테스트 코드 작성**: Admin state-machine, Customer/Sponsor 이벤트 파싱 등 핵심 로직 테스트
- [ ] **에러 처리 강화**: 네트워크 오류, 파싱 실패 등 예외 상황 처리
- [ ] **로깅 개선**: 디버깅 용이하도록 구조화된 로그

---

**Last Updated**: 2026-03-07
