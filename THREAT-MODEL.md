# Threat Model — 페어바이

어뷰징 시나리오, 레이스 컨디션, 엣지 케이스 정리.
코드 수정 시 이 문서를 참조하여 기존 방어가 무력화되지 않는지 확인한다.

## 2026-09-12 통합으로 생긴 축 — 한 사람이 양쪽 역할

고객앱과 후원자앱이 한 앱·한 키가 되면서 **같은 pubkey가 양쪽 역할을 겸한다.**
이전에는 오리진이 달라 키가 갈렸기 때문에 도달 불가능하던 경로들이 열렸다.

| 벡터 | 대응 | 위치 |
|---|---|---|
| 자기 주문을 자기가 클레임 | Admin FSM이 `request.pubkey === order.customerPubkey`면 거부 | `handleClaim` |
| 내 주문이 내 오더북에 클레임 가능하게 노출 | `sponsorRelation`이 `own`으로 판정 (customerPubkey 검사가 requested 검사보다 **먼저**) | `shared/sponsor-relation` |
| 남의 거래 정보를 내 것으로 오인 | 계좌·보증금 섹션을 `isMine` 게이트로 묶음 | `sponsor/components/OrderCard` |

자기 클레임 차단은 단순 어뷰징 방지를 넘어 **내역 화면의 전제**다 — 막지 않으면
`customerPubkey === sponsorPubkey`인 오더가 생겨 "어느 역할로 참여했는가"를 유도할 수 없다.

## 2026-09-13 감사에서 닫은 것

| 항목 | 요지 |
|---|---|
| 무솔트 커밋먼트 | 공개 커밋먼트만으로 계좌번호 브루트포스 가능 → 32바이트 솔트 도입 |
| 이중 지급 재진입 | `disbursed` 검사와 기록 사이에 LN 결제 await → 키 단위 재진입 가드 |
| 쿠팡 주문번호 공개 | orderId로 쓰여 a-태그에 노출 → 랜덤 orderId + 유저스크립트 자기주소 채널 |
| orderId 선점 DoS | 남의 쿠팡 번호를 미리 등록해 차단 가능 → 랜덤 id로 함께 해소 |
| 계좌 공개 버튼 상시 노출 | `remitted`(정상 상태)에서 열려 있어 분쟁도 아닌데 계좌가 Admin에게 흘러감 → `reveal-request` 게이트 |

상세와 미처리 항목은 [docs/AUDIT-2026-09-13.md](docs/AUDIT-2026-09-13.md).

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
| **방어** | ✅ Sponsor 보증금(Fidelity Bond) — claim 시 소액 hold invoice 결제 필수. 트롤링 시 보증금 몰수(customer_wins). BTC 없는 Sybil은 원천 차단. 추가 방어로 Lightning 노드 블랙리스트 도입 가능(보류). |
| **관련** | SECURITY-ROADMAP.md — S-001, [DESIGN-DEPOSIT.md](docs/DESIGN-DEPOSIT.md) |

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

## 시스템 불변조건 (Safety Invariants)

어떠한 코드 변경에서도 절대 깨지면 안 되는 조건.
위협 모델이 "어떻게 깨질 수 있나"를 다룬다면, 불변조건은 "절대 깨지면 안 되는 것"을 정의한다.
테스트 코드가 도입되면 각 항목에 대응하는 테스트 케이스를 작성해야 한다.

### I-001. Hold invoice preimage는 settle 전까지 Admin만 접근 가능해야 한다

| 항목 | 내용 |
|------|------|
| **보호 대상** | BTC (에스크로 자금) |
| **불변조건** | Preimage가 유출되면 누구든 hold invoice를 settle하여 BTC를 탈취할 수 있다. Preimage는 NIP-44 암호화 상태로만 저장되어야 하며, 평문은 인메모리 캐시에서만 존재해야 한다. |
| **현재 구현** | escrow-store: NIP-44 암호화 localStorage + NIP-78 릴레이 백업 (S-002) |

---

### I-002. 보증금 hold invoice는 Sponsor 클레임 전 취소/만료 시 반드시 cancel(환불)되어야 한다

| 항목 | 내용 |
|------|------|
| **보호 대상** | Customer BTC (보증금) |
| **불변조건** | Customer가 주문을 취소하거나 오더가 만료되었는데 아직 Sponsor가 관여하지 않은 경우, 보증금은 전액 환불되어야 한다. 오더 발행 전(pending deposit 단계) 만료/취소 시에도 동일. 이유 없이 Customer의 자금을 묶어두거나 몰수하는 것은 신뢰 훼손. |
| **판단 기준** | `order.sponsorPubkey`가 없으면 → cancel (환불). 오더 미발행 상태면 무조건 cancel. |
| **관련 설계** | [DESIGN-DEPOSIT.md](DESIGN-DEPOSIT.md) 보증금 생명주기 |

---

### I-003. 실결제 hold invoice는 정당한 사유 없이 settle되어서는 안 된다

| 항목 | 내용 |
|------|------|
| **보호 대상** | Customer BTC (에스크로) |
| **불변조건** | Settle = BTC가 Admin에게 확정적으로 이전됨. `paid` (Customer 컨펌), `sponsor_wins` (Admin 분쟁 판정), 또는 safety-net (만료 임박 비대칭 손실 방어) 경우에만 settle 허용. |
| **현재 구현** | handlePaymentConfirm, resolveDisputeSponsorWins, invoice-watcher safety-net |

---

### I-004. customer_wins 판정 시 hold invoice는 반드시 cancel(환불)되어야 한다

| 항목 | 내용 |
|------|------|
| **보호 대상** | Customer BTC (에스크로) |
| **불변조건** | Customer 승리 = BTC 반환. 이미 settled인 경우 별도 LN 결제로 수동 환불 필요 (경고 발생). |
| **현재 구현** | resolveDisputeCustomerWins에서 cancel 호출, settled면 warning 반환 |

---

### I-005. 보증금은 실결제(escrowed) 시점에 반드시 cancel(환불)되어야 한다

| 항목 | 내용 |
|------|------|
| **보호 대상** | Customer BTC (보증금) |
| **불변조건** | 실결제 hold invoice가 담보 역할을 인수하는 시점에서 보증금의 역할은 끝난다. 이중으로 Customer 자금을 묶어두지 않는다. |
| **관련 설계** | [DESIGN-DEPOSIT.md](DESIGN-DEPOSIT.md) 보증금 생명주기 |

---

### I-006. 만료된 오더의 모든 hold invoice는 정리되어야 한다

| 항목 | 내용 |
|------|------|
| **보호 대상** | Customer BTC (보증금 + 에스크로), Sponsor BTC (보증금) |
| **불변조건** | cleanup이 만료 오더를 삭제할 때, 해당 오더에 연관된 hold invoice(고객 보증금, 후원자 보증금, 실결제)가 아직 active면 적절히 cancel/settle 처리. 방치된 hold invoice는 CLTV timeout까지 자금을 불필요하게 잠근다. |
| **현재 구현** | cleanup.ts에서 escrow purge만 수행. hold invoice cancel 미구현 (향후 개선) |

---

### I-007. Sponsor 보증금은 정상 완료(paid) 또는 Sponsor 승리 시 반드시 cancel(환불)되어야 한다

| 항목 | 내용 |
|------|------|
| **보호 대상** | Sponsor BTC (보증금) |
| **불변조건** | Sponsor가 KRW를 정상 송금하여 거래가 완료(paid)되었거나, 분쟁에서 Sponsor가 승리(sponsor_wins)한 경우 보증금은 전액 환불되어야 한다. 정상 행동을 한 Sponsor의 자금을 묶어두거나 몰수하는 것은 신뢰 훼손. |
| **현재 구현** | deposit-lifecycle.ts handleSponsorDeposit: paid/sponsor_wins → cancel (환불) |
| **관련 설계** | [DESIGN-DEPOSIT.md](docs/DESIGN-DEPOSIT.md) 보증금 생명주기 |

---

### I-008. Sponsor 보증금은 Customer 승리 시 settle(몰수)되어야 한다

| 항목 | 내용 |
|------|------|
| **보호 대상** | Customer (보상), 시스템 (트롤링 억제) |
| **불변조건** | 분쟁에서 Customer가 승리(customer_wins) = Sponsor의 트롤링/의무 불이행이 인정됨. 이 경우 보증금을 몰수하여 트롤링 비용을 부과한다. |
| **현재 구현** | deposit-lifecycle.ts handleSponsorDeposit: customer_wins → settle (몰수) |
| **관련 설계** | [DESIGN-DEPOSIT.md](docs/DESIGN-DEPOSIT.md) 보증금 생명주기 |

---

## 변경 시 체크리스트

코드 수정 시 아래 항목을 확인한다:

- [ ] FSM 전이 규칙 변경 시: 위 위협 시나리오들이 여전히 방어되는가?
- [ ] 새로운 request action 추가 시: 해당 action을 사칭할 수 있는 주체는 누구인가?
- [ ] 상태 전이 자동화 시: 레이스 컨디션이 발생할 수 있는 구간은 없는가?
- [ ] hold invoice 관련 변경 시: CLTV timeout 안전장치가 여전히 유효한가?
- [ ] Customer/Sponsor 권한 변경 시: 한쪽에게 일방적으로 유리한 조건이 생기지 않는가?
- [ ] hold invoice cancel/settle 추가 시: 위 Safety Invariants가 여전히 충족되는가?
- [ ] 고객 보증금 관련 변경 시: I-002, I-005, I-006이 유지되는가?
- [ ] 후원자 보증금 관련 변경 시: I-006, I-007, I-008이 유지되는가?

---

**Last Updated**: 2026-03-23
