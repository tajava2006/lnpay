# 보안 및 아키텍처 개선 로드맵

> 프로토타입 → 프로덕션 전환을 위한 기술/보안/아키텍처 이슈 추적 문서.
> 각 항목은 독립적으로 해결 가능하며, 우선순위 순으로 정렬되어 있다.

## Phase 1: 출시 차단 (Launch Blockers)

출시 전 반드시 해결해야 하는 항목. 미해결 시 실제 자금 손실 또는 서비스 불능 위험.

---

### S-001. Customer Fidelity Bond 구현

| 항목 | 내용 |
|------|------|
| **분류** | 보안 — 스팸/DoS 차단 |
| **심각도** | Critical |
| **현재 상태** | 미구현 (TODO.md에만 기재) |
| **문제** | 누구든 무료로 Nostr 키를 생성하여 가짜 order-request를 무한 발행 가능. 오더북이 오염되면 Sponsor가 실제 주문을 식별할 수 없어 서비스 불능. |
| **설계** | [PROTOCOL.md](PROTOCOL.md) §스팸/DoS 차단, [ARCHITECTURE.md](ARCHITECTURE.md) §Fidelity Bond에 이미 설계됨 |
| **구현 범위** | 1. Admin: order-request 수신 시 소액 hold invoice 생성 + Customer에게 전달 <br> 2. Customer: hold invoice 결제 UI (기존 InvoiceModal 재사용 가능) <br> 3. Admin: 결제 확인 후 오더 생성 (invoice-watcher 확장) <br> 4. Admin: 클레이머 확정 시 fidelity bond cancel → 본 hold invoice 재발행 |
| **참고** | RoboSats는 maker/taker 모두에게 fidelity bond를 요구한다 |

---

### S-002. Preimage 보호 및 백업

| 항목 | 내용 |
|------|------|
| **분류** | 보안 — 자금 보호 |
| **심각도** | Critical |
| **현재 상태** | `admin/src/escrow-store.ts`에서 localStorage 평문 저장 |
| **문제 1 — XSS 탈취** | Preimage = hold invoice settle 권한 = BTC 수령 권한. XSS 공격 하나로 활성 에스크로의 모든 preimage 탈취 가능. |
| **문제 2 — 데이터 소실** | 브라우저 데이터 삭제 시 preimage 영구 손실 → settle 불가, BTC 제어권 상실. CLTV timeout까지 자금이 잠기고 Admin이 할 수 있는 것이 없다. |
| **해결안 A (최소)** | Web Crypto API `subtle.encrypt(AES-GCM)`으로 세션키 기반 암호화 후 저장. 세션키는 NIP-46 인증 시 파생. |
| **해결안 B (권장)** | Preimage를 NIP-78 + NIP-44로 암호화하여 릴레이에 백업 (LN config과 동일 패턴). 브라우저 초기화 시에도 복원 가능. |
| **해결안 C (이상적)** | Preimage를 브라우저에 저장하지 않고, settle 시점에만 LN 노드에서 조회하는 구조로 전환. LND `AddHoldInvoice`의 preimage 서버 보관 기능 활용. |

---

### S-003. Lightning 노드 블랙리스트 구현

| 항목 | 내용 |
|------|------|
| **분류** | 보안 — 스팸/트롤링 차단 |
| **심각도** | Critical |
| **현재 상태** | 미구현 (TODO.md에만 기재) |
| **문제** | Sponsor가 claim만 하고 KRW 미송금 반복 가능. Nostr pubkey 무료 생성으로 무한 반복. Customer의 BTC가 hold invoice에 불필요하게 묶임. |
| **설계** | [PROTOCOL.md](PROTOCOL.md) §Sponsor 스팸 차단에 이미 설계됨 |
| **구현 범위** | 1. claim 수신 시 bolt11 디코딩 → destination node pubkey 추출 <br> 2. 블랙리스트(NIP-78 암호화 저장) 대조 → 차단 시 자동 거절 <br> 3. Admin UI: 블랙리스트 관리 (추가/제거/조회) <br> 4. 분쟁 판정 시 자동 블랙리스트 등록 옵션 |

---

### S-004. Admin 상시 프로세스 분리 (Invoice Watcher)

| 항목 | 내용 |
|------|------|
| **분류** | 아키텍처 — 가용성 |
| **심각도** | Critical |
| **현재 상태** | invoice-watcher가 Admin 브라우저 탭 내에서만 동작 |
| **문제** | Admin이 탭을 닫거나 브라우저가 크래시하면: <br> - `verified → escrowed` 자동 전이 중단 <br> - remitted 오더의 만료 임박 auto-settle 미작동 <br> - 최악의 경우 Sponsor가 KRW를 보냈는데 hold invoice CLTV 만료로 BTC가 Customer에게 환불 → Sponsor 자금 손실 |
| **해결안 A (최소)** | Node.js 경량 서비스로 invoice-watcher + auto-settle 로직만 분리. LN 노드와 직접 통신. 브라우저 앱과 localStorage/IDB 공유 불필요 — 릴레이 이벤트로 상태 동기화. |
| **해결안 B (단계적)** | Phase 1: 브라우저 탭 유지 의존 + 알림(S-011)으로 Admin에게 경고. Phase 2: 별도 프로세스 분리. |
| **트레이드오프** | 순수 프론트엔드 원칙을 일부 포기. 하지만 에스크로 서비스에서 가용성은 타협 불가. |

---

### S-005. FSM 및 핵심 로직 테스트

| 항목 | 내용 |
|------|------|
| **분류** | 품질 — 신뢰성 |
| **심각도** | High |
| **현재 상태** | 테스트 0개 |
| **문제** | 에스크로 FSM, pubkey 검증, 가격 범위 검증 등 자금 관련 로직에 테스트가 없다. 리팩터링이나 기능 추가 시 기존 방어가 무력화될 위험. |
| **구현 범위** | 1. `state-machine.ts`: 모든 전이 경로 허용/거부 테스트 <br> 2. `service.ts` 핸들러: pubkey 검증 (payment-confirm, cancel-request, remit-request) <br> 3. 가격 범위 검증: edge case (0, NaN, negative, null price feed) <br> 4. invoice-watcher: 상태별 동작 (accepted, settled, cancelled, 만료 임박) <br> 5. commitment 검증: hash 일치/불일치 |
| **도구** | vitest (Vite 프로젝트에 자연스럽게 통합) |

---

## Phase 2: 출시 필수 (Must Fix Before Launch)

출시 직전까지 해결해야 하는 항목. 미해결 시 보안 취약점이 존재하나 즉각적 자금 손실 위험은 Phase 1보다 낮다.

---

### S-006. 유저스크립트 innerHTML XSS 수정

| 항목 | 내용 |
|------|------|
| **분류** | 보안 — XSS |
| **심각도** | High |
| **위치** | `customer/userscript/src/main.ts:140-164` |
| **문제** | `showNotification()`에서 쿠팡 상품명을 `innerHTML`로 직접 삽입. 상품명에 HTML payload가 있으면 쿠팡 도메인 컨텍스트에서 JS 실행 → 쿠팡 세션 탈취 가능. |
| **수정** | `innerHTML` → DOM API(`createElement` + `textContent`)로 변경. 또는 최소한 HTML 이스케이핑 적용. |

---

### S-007. Nostr 이벤트 서명 명시적 검증

| 항목 | 내용 |
|------|------|
| **분류** | 보안 — Defense in Depth |
| **심각도** | Medium |
| **위치** | 3개 앱의 `parseRequestEvent()`, `parseOrderEvent()` |
| **문제** | nostr-tools SimplePool의 내부 검증에만 의존. 악의적 릴레이가 서명 없는 이벤트를 주입하면 FSM이 잘못된 전이를 할 수 있다. 라이브러리 업데이트로 동작이 바뀔 수도 있다. |
| **수정** | `nostr-tools`의 `verifyEvent()` 호출을 파싱 함수에 추가. 검증 실패 시 이벤트 폐기 + 경고 로그. |

---

### S-008. 가격 피드 없을 때 Claim 거부

| 항목 | 내용 |
|------|------|
| **분류** | 보안 — 가격 조작 방어 |
| **심각도** | Medium |
| **위치** | `admin/src/nostr/service.ts:619` (`handleClaim`) |
| **문제** | `btcPrice`가 null(3개 거래소 모두 다운)이면 가격 검증을 건너뛰고 어떤 금액의 invoice든 claim이 통과한다. |
| **수정** | 가격 피드 없으면 claim을 거부하고 Admin에게 수동 확인 요청. 또는 마지막 유효 가격 + 타임스탬프를 캐시하여 N분 이내면 허용. |

---

### S-009. `escrowed → paid` 직접 전이 — UX 실수 방지

| 항목 | 내용 |
|------|------|
| **분류** | UX — 오조작 방지 |
| **심각도** | Low |
| **위치** | `admin/src/state-machine.ts:29`, Customer 앱 UI |
| **현재 설계가 안전한 이유** | `payment-confirm`은 "Sponsor가 KRW를 보낸 것을 Customer가 확인"하는 행위다. Customer가 거짓 확인을 보내면 자기 BTC만 잃으므로 **속일 유인이 전혀 없다.** 이건 보안 이슈가 아니다. |
| **실제 위험** | Customer가 Sponsor의 `remit-request` 없이 **실수로** 송금 확인 버튼을 누르는 것. Sponsor가 KRW를 보내고 `remit-request`를 깜빡할 수도 있으므로 이 전이 자체를 금지하면 정상 플로우에 방해가 된다. |
| **수정** | Customer UI에서 `escrowed` 상태에서 송금 확인 시 경고 다이얼로그: "Sponsor가 아직 송금 완료 신호를 보내지 않았습니다. 정말로 송금이 확인되었습니까? 이 작업은 되돌릴 수 없습니다." |

---

## Phase 3: 출시 후 개선 (Post-Launch Hardening)

출시 후 점진적으로 개선하는 항목.

---

### S-010. Cleanup vs Invoice Watcher 타이밍 경합

| 항목 | 내용 |
|------|------|
| **분류** | 아키텍처 — 레이스 컨디션 |
| **심각도** | Medium |
| **위치** | `admin/src/cleanup.ts` (60초 주기), `admin/src/invoice-watcher.ts` (15초 주기, 만료 10분 전 auto-settle) |
| **문제** | 설계 의도: auto-settle(만료 10분 전) → cleanup(만료 시). 하지만 **Admin 앱을 만료 10분 이내에 처음 열면** cleanup이 먼저 실행되어 오더를 localStorage에서 삭제할 수 있다. 이후 invoice-watcher가 해당 오더를 찾지 못하여 auto-settle이 작동하지 않는다. remitted 오더에서 이 경우 Sponsor의 KRW이 위험해진다. |
| **해결안 A** | cleanup에서 `remitted` 상태 오더는 만료되어도 삭제하지 않는다 (분쟁 판정 전까지 보존). |
| **해결안 B** | cleanup 실행 전에 invoice-watcher의 remitted 처리를 먼저 트리거한다 (순서 보장). |
| **해결안 C** | invoice-watcher가 localStorage뿐 아니라 IndexedDB도 조회하도록 변경 (IDB는 cleanup이 삭제하지 않으므로 항상 존재). |

---

### S-011. Admin 알림 메커니즘

| 항목 | 내용 |
|------|------|
| **분류** | 운영 — 모니터링 |
| **심각도** | Medium |
| **문제** | hold invoice settle 실패, LN 노드 다운, remitted 장기 방치 등 critical event에 대한 알림이 없다. Admin이 앱을 보고 있지 않으면 문제를 인지할 수 없다. |
| **구현안** | Nostr DM(NIP-17) 또는 Telegram bot으로 critical event 알림. 최소 대상: <br> - LN 노드 연결 끊김 <br> - hold invoice settle 실패 <br> - remitted 오더 N시간 이상 방치 <br> - 가격 피드 전체 중단 |

---

### S-012. Macaroon 최소 권한 제한

| 항목 | 내용 |
|------|------|
| **분류** | 보안 — 최소 권한 원칙 |
| **심각도** | Medium |
| **위치** | `admin/src/lightning/lnd.ts` |
| **문제** | XSS 공격으로 macaroon 탈취 시 노드 전체 제어권이 넘어간다. Admin macaroon의 권한 범위가 문서화되지 않았다. |
| **수정** | LND baked macaroon으로 필요한 RPC만 허용: `invoicesrpc.AddHoldInvoice`, `invoicesrpc.SettleInvoice`, `invoicesrpc.CancelInvoice`, `invoicesrpc.LookupInvoiceV2`, `routerrpc.SendPaymentV2`, `lnrpc.GetInfo`, `lnrpc.DecodePayReq`. <br> 채널 관리, 온체인 출금 등은 제외. |

---

### S-013. 가격 오라클 강화

| 항목 | 내용 |
|------|------|
| **분류** | 보안 — 가격 조작 방어 |
| **심각도** | Low |
| **위치** | `shared/src/price.ts` |
| **문제** | 거래소 2개 다운 시 1개 가격만으로 중간값 계산. 이론적으로 MITM 공격 가능. |
| **개선안** | 1. 최소 연결 거래소 수 제한 (2개 미만이면 가격 무효화) <br> 2. 이전 가격 대비 급격한 변동(±10% 등) 시 이상치 필터링 <br> 3. 가격 타임스탬프 기록 → stale 가격(30초+) 사용 방지 |

---

### S-014. IDB 동기화 에러 핸들링

| 항목 | 내용 |
|------|------|
| **분류** | 품질 — 데이터 무결성 |
| **심각도** | Low |
| **위치** | `admin/src/nostr/service.ts` 전반 (`void syncRequestToIdb()` 패턴) |
| **문제** | IDB 쓰기가 fire-and-forget. 실패해도 앱이 정상 동작하는 것처럼 보이지만 히스토리에 데이터 누락. 에스크로 증거 보존 관점에서 문제. |
| **수정** | IDB 쓰기 실패 시 재시도 큐 + Admin UI에 경고 배지 표시. |

---

### S-015. localStorage 스키마 버전 관리

| 항목 | 내용 |
|------|------|
| **분류** | 품질 — 데이터 마이그레이션 |
| **심각도** | Low |
| **위치** | 3개 앱의 `order-store.ts`, `request-store.ts`, `escrow-store.ts` |
| **문제** | `JSON.parse()`로 읽은 데이터를 타입 캐스팅만 하고 런타임 검증 없음. 스키마 변경 시 기존 데이터와 호환되지 않을 수 있다. 버전 관리 메커니즘 없음. |
| **수정** | 스토리지 키에 버전 접미사 (예: `admin:orders:v2`) + 마이그레이션 함수. 또는 zod 등으로 런타임 파싱 검증. |

---

## 변경 시 체크리스트

이 문서의 항목을 해결할 때 아래를 확인한다:

- [ ] [THREAT-MODEL.md](THREAT-MODEL.md)의 기존 방어가 무력화되지 않는가?
- [ ] FSM 전이 규칙을 변경했다면 S-005의 테스트가 통과하는가?
- [ ] 새로운 localStorage 키를 추가했다면 S-015 패턴을 따르는가?
- [ ] LN API 호출을 추가했다면 S-012의 macaroon 권한에 포함되는가?
- [ ] 릴레이에 데이터를 저장한다면 NIP-44 암호화를 적용했는가?

---

**Last Updated**: 2026-03-20
