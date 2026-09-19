# TODO - 페어바이

미구현 기능 및 개선 사항 목록

> 앱 구조가 **2026-09-12 통합**으로 바뀌었다. 아래의 "Customer App / Sponsor App" 구분은
> 이제 통합 앱의 **의뢰하기 / 사주기 탭**을 가리킨다.
>
> 보안·문서·공학 개선 항목은 [AUDIT-2026-09-13.md](docs/AUDIT-2026-09-13.md)에 따로 있다.

## Customer App

### 결제 관련

- [ ] **입금/취소 자동 감지 주기적 폴링**: 현재 유저스크립트가 쿠팡 페이지 방문 시에만 감지
  - 2026-09-13부터 감지 결과가 웹앱을 거쳐 어드민에 전달된다(감사 A-3).
    즉 "쿠팡 페이지 방문"과 "웹앱 열기"가 둘 다 필요해졌다
  - 유저스크립트에서 주기적 API 폴링 또는 Service Worker 활용 고려
  - 페이지 방문 없이도 상태 변화 감지 가능하도록 확장

### UI/UX

- [x] **알림 기능**: 상태 변경 시 브라우저 알림 ✅ Web Push (2026-09-17). 설계 = 어드민이
      RFC 8291로 직접 암호화, nginx 중계 경유. NIP-17 경로는 코드만 남기고 꺼둠
  - Admin 오더 상태 변경 수신 시 (claimed, verified, escrowed, paid 등)
  - 입금 완료 시

## Sponsor App

- [ ] **오더북 페이지네이션**: 의뢰가 많아질 경우 대비
- [ ] **스타일링 고도화**: 현재 인라인 스타일 → CSS 또는 스타일링 라이브러리 (감사 C-5에서 이관)

## Admin App (에스크로 서비스)

### 정산 (BTC 지급/환불)

- [x] **bolt11 만료 시 처리** ✅ (2026-09-18) 제출 시 최소 수명(6h) + 에스크로 잔여시간 검사,
      지급 직전 재검사, 만료 시 `EXPIRED_BEFORE_PAYOUT` 통보 → 후원자 앱이 폼을 다시 연다
- [ ] **고객 승리 → 고객에게 BTC 환불**: 만료 임박 선제 settle로 hold invoice가 이미 settle된 경우, 별도 LN 결제로 고객에게 반환
  - 고객의 LN 수신 인보이스를 받는 메커니즘 필요

### 기타

- [ ] **릴레이 목록 관리**: kind 10002 이벤트 발행/수정 UI
- [ ] **모니터링 대시보드**: 시스템 전체 현황 파악

### 어드민 운영

- [ ] **버려진 에스크로 정리**: `escrowed`/`invoiced`에서 방치된 의뢰의 hold invoice를
      앱에서 취소할 방법이 없다. 지금은 `lncli cancelinvoice`로 내려가야 하고, 그동안
      유동성이 묶인다(2026-09-19 실측 — CLN askrene이 그 채널을 통째로 막았다).
      설계 방향 = 어드민 전용 종결 상태 추가 + 주문 상세에 세 자금(고객 보증금·후원자
      보증금·에스크로)의 현 상태 표시
- [ ] **invoiced 정체 감지**: 후원자가 인보이스를 안 내면 조용히 CLTV 타임아웃까지 간다.
      손실은 없지만 알려주는 편이 낫다

## 대규모 아이디어

- [ ] **온체인 전용 트랙**: 라이트닝이 아니라 taproot 2-of-3 에스크로.
      쿠팡 결제가 아니라 non-KYC 비트코인 거래 용도(유저 피드백). 수수료 0(온체인만),
      happy path에서 어드민 무개입. 검토 = [docs/IDEA-ONCHAIN-TRACK.md](docs/IDEA-ONCHAIN-TRACK.md)

## 스팸/DoS 차단

### Customer 스팸 차단

- [x] **Fidelity bond**: order-request 발행 시 주문 금액의 일부를 hold invoice로 선납 ✅
  - BTC가 없는 스패머 원천 차단 (어차피 Customer가 지불할 금액이므로 추가 비용 아님)
  - 정확한 금액이 아닌 보증 목적의 소액 (BTC 가격 변동 대응)
  - 클레이머 확정 + 유동성 검증 통과 시 fidelity bond cancel (즉시 환불)
  - 해당 시점의 정확한 BTC/KRW 환율로 본 hold invoice 재발행

### Sponsor 스팸 차단

- [ ] **Lightning 노드 블랙리스트 (보류)**: Sponsor 보증금으로 스팸 게이트 확보됨. 규모 확장 시 추가 방어로 도입 검토
  - invoice의 destination node pubkey로 Sponsor 식별
  - 트롤링 발생 시 해당 노드 블랙리스트 등록, Admin 웹앱에서 관리 UI
- [x] **Sponsor fidelity bond**: claim 시 주문 금액의 일부를 hold invoice로 보증금 수령 ✅
  - paid/sponsor_wins 시 자동 환불, customer_wins 시 몰수

## BTC 가격 활용

- [ ] **결제 금액 실시간 BTC 환산**: Customer 대시보드에서 주문 금액 옆에 BTC 환산 표시

## 기술 부채

- [ ] **CLN hold invoice 지원**: 현재 LND 전용 (`holdInvoice`, `settleInvoice`). CLN은 probe만 가능하고 hold invoice API 미구현
- [x] **테스트 코드 작성**: Admin FSM 전이, 가격 범위 검증, commitment hash, 구독 가드,
  진행도 모델, 자기 클레임 차단 — vitest 82개 테스트 ✅
  - ⚠️ 러너가 admin에만 있어 shared 모듈 테스트를 admin 호스트에 얹어 둔 상태
    → [AUDIT-2026-09-13.md](docs/AUDIT-2026-09-13.md) C-3
- [ ] **에러 처리 강화**: 네트워크 오류, 파싱 실패 등 예외 상황 처리
- [ ] **로깅 개선**: 디버깅 용이하도록 구조화된 로그

---

**Last Updated**: 2026-09-13 (앱 통합 반영, 감사 문서 분리)
