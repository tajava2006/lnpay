# Threat Model — 사줘 트래커

어뷰징 시나리오, 레이스 컨디션, 엣지 케이스 정리.
코드 수정 시 이 문서를 참조하여 기존 방어가 무력화되지 않는지 확인한다.

## 위협 목록

### T-001. Customer cancel-request 사칭

| 항목 | 내용 |
|------|------|
| **공격자** | Customer |
| **시나리오** | 유저스크립트의 자동 취소 감지 이벤트를 수동으로 사칭하여 `cancel-request`를 발행. Admin은 자동 감지인지 사칭인지 구별 불가 (개인키가 동일). |
| **영향** | `escrowed` 이후 취소가 허용되면 Sponsor가 KRW을 보냈는데 거래가 취소될 수 있음. |
| **방어** | `escrowed` 이후 상태에서 `cancelled` 전이를 FSM에서 차단. Customer의 `cancel-request`는 `requested`/`claimed`/`verified`에서만 유효. |
| **관련 코드** | `admin/src/state-machine.ts` TRANSITIONS, `admin/src/nostr/service.ts` handleCancelRequest |

---

### T-002. Customer 에스크로 후 쿠팡 직접 취소 → 환불금 착복

| 항목 | 내용 |
|------|------|
| **공격자** | Customer |
| **시나리오** | 에스크로 상태에서 계좌 정보를 Sponsor에게 전달 → Sponsor가 KRW 송금 → Customer가 쿠팡 앱에서 직접 주문 취소 → 환불금이 Customer 지정 계좌로 입금. KRW과 BTC(hold invoice cancel 시) 모두 착복 가능. |
| **영향** | Sponsor가 KRW을 잃음. |
| **방어** | `escrowed → cancelled` 전이 차단으로 Customer가 앱 내에서 취소 불가. 쿠팡 직접 취소가 발생해도 Sponsor가 `remitted` 상태로 전이했다면 Admin이 분쟁 판정. Sponsor가 미송금이면 hold invoice CLTV timeout으로 자연 해소. |
| **관련 코드** | `admin/src/state-machine.ts` TRANSITIONS |

---

### T-003. Sponsor remit-request 전 Customer의 선취적 취소 (레이스 컨디션)

| 항목 | 내용 |
|------|------|
| **공격자** | Customer |
| **시나리오** | Sponsor가 KRW을 송금하고 `remit-request`를 발행하기 직전, Customer가 `cancel-request`를 먼저 발행. `escrowed → cancelled` 전이가 허용되면 Sponsor의 KRW이 공중에 뜸. |
| **영향** | Sponsor가 KRW을 보냈지만 거래가 취소되어 BTC를 받지 못함. |
| **방어** | `escrowed → cancelled` 전이 차단. Sponsor가 송금 후 `remit-request`를 보내면 `remitted` 상태로 전이되고, 분쟁 판정 경로로만 종결. |
| **관련 코드** | `admin/src/state-machine.ts` TRANSITIONS |

---

### T-004. Sponsor 미송금 + 거짓 remit-request

| 항목 | 내용 |
|------|------|
| **공격자** | Sponsor |
| **시나리오** | KRW을 보내지 않고 `remit-request`를 발행하여 `remitted` 상태로 전이. Customer가 입금을 확인할 수 없어 교착 상태. |
| **영향** | Customer의 BTC가 hold invoice에 묶여있는 동안 거래 지연. |
| **방어** | Admin이 분쟁 판정 시 송금 증거(계좌 이체 내역)를 요구. 증거 불충분 시 `customer_wins` → hold invoice 환불. hold invoice CLTV timeout이 최종 안전장치. |
| **관련 코드** | `admin/src/nostr/service.ts` resolveDisputeCustomerWins |

---

### T-005. Sponsor Nostr pubkey 교체를 통한 Sybil 공격

| 항목 | 내용 |
|------|------|
| **공격자** | Sponsor |
| **시나리오** | Nostr pubkey는 무료 생성 가능. 트롤링/스팸 후 새 키로 전환하면 블랙리스트 우회 가능. |
| **영향** | 반복적인 거짓 claim으로 Customer 거래 방해. |
| **방어** | (미구현) Lightning 노드 pubkey 기반 식별 — 채널 펀딩에 실제 BTC 필요하므로 Sybil 비용 높음. bolt11의 destination pubkey로 Sponsor를 식별하고 블랙리스트 관리. |
| **관련** | TODO.md — Lightning 노드 블랙리스트 |

---

### T-006. Hold invoice CLTV timeout에 의한 자연 만료

| 항목 | 내용 |
|------|------|
| **유형** | 엣지 케이스 (비악의적) |
| **시나리오** | `escrowed` 상태에서 Sponsor가 행동하지 않아 hold invoice가 CLTV timeout으로 자동 환불됨. 앱 상태는 `escrowed`로 유지. |
| **영향** | BTC는 Customer에게 반환되지만 앱 UI에는 여전히 에스크로 상태로 표시됨. |
| **현재 처리** | 앱 상태는 `escrowed`로 남아있으나, hold invoice 만료 이후 실질적으로 거래는 불발. Customer에게 실질적 피해 없음 (BTC 자동 환불). |
| **향후 개선** | Admin이 LN 노드에서 hold invoice 만료를 감지하여 앱 상태를 갱신하는 메커니즘 검토 가능. |

---

### T-007. 유저스크립트 비활성화를 통한 자동 감지 우회

| 항목 | 내용 |
|------|------|
| **유형** | 설계 한계 |
| **시나리오** | Customer가 Tampermonkey를 비활성화하거나 쿠팡 앱(모바일)에서 작업하면 유저스크립트의 자동 감지(입금 컨펌, 취소 감지)가 작동하지 않음. |
| **영향** | 자동 `payment-confirm`이나 `cancel-request`가 발행되지 않아 상태 전이가 지연됨. |
| **현재 처리** | Customer가 수동으로 입금 컨펌 버튼을 누르거나, 궁극적으로 hold invoice CLTV timeout이 안전장치 역할. |
| **향후 개선** | TODO — 주기적 API 폴링으로 페이지 방문 없이도 상태 변화 감지 |

---

## 변경 시 체크리스트

코드 수정 시 아래 항목을 확인한다:

- [ ] FSM 전이 규칙 변경 시: 위 위협 시나리오들이 여전히 방어되는가?
- [ ] 새로운 request action 추가 시: 해당 action을 사칭할 수 있는 주체는 누구인가?
- [ ] 상태 전이 자동화 시: 레이스 컨디션이 발생할 수 있는 구간은 없는가?
- [ ] hold invoice 관련 변경 시: CLTV timeout 안전장치가 여전히 유효한가?
- [ ] Customer/Sponsor 권한 변경 시: 한쪽에게 일방적으로 유리한 조건이 생기지 않는가?

---

**Last Updated**: 2026-03-14
