# 사줘 트래커 시스템 아키텍처

## 개요

"사줘 트래커"는 쿠팡 무통장입금 주문을 추적하고, 다른 사람에게 대신 결제를 요청할 수 있는 시스템이다.
탈중앙화 통신 프로토콜인 **Nostr**를 통해 사용자 간 메시지를 주고받는다.

## 시스템 구성

```
┌─────────────────────────────────────────────────────────────────┐
│                         Nostr Network                           │
│                    (탈중앙화 릴레이 서버)                          │
└─────────────────────────────────────────────────────────────────┘
        ↑                    ↑                    ↑
        │                    │                    │
   ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
   │ Customer │          │ Sponsor │          │  Admin  │
   │   App    │          │   App   │          │   App   │
   └─────────┘          └─────────┘          └─────────┘
```

### 레포지토리 구조

| 폴더 | 설명 | 대상 사용자 |
|------|------|------------|
| `customer/` | 사줘 요청을 보내는 고객용 앱 | 물건을 사달라고 요청하는 사람 |
| `sponsor/` | 사줘 요청을 받고 결제하는 후원자용 앱 | 대신 결제해주는 사람 |
| `admin/` | 시스템 관리자용 앱 | 시스템 운영자 |
| `nostr-tools/` | Nostr 프로토콜 라이브러리 (참고용) | - |

## Nostr 프로토콜

### 왜 Nostr인가?

- **탈중앙화**: 중앙 서버 없이 릴레이를 통해 P2P 통신
- **검열 저항**: 특정 서버에 의존하지 않음
- **프라이버시**: 공개키 기반 암호화로 익명성 보장
- **확장성**: 다양한 릴레이 서버 활용 가능

### 통신 흐름

```
1. 주문 감지 (Customer)
   └─> 쿠팡 주문 상세 페이지에서 무통장입금 주문 감지

2. 사줘 요청 발송 (Customer → Nostr)
   └─> Nostr 이벤트로 사줘 요청 브로드캐스트

3. 요청 수신 (Sponsor)
   └─> 릴레이에서 사줘 요청 이벤트 구독

4. 클레임 응답 (Sponsor → Nostr)
   └─> "내가 사줄게" 응답 이벤트 발송

5. 선택 및 확정 (Customer)
   └─> 클레이머 중 한 명 선택, 계좌 정보 전달

6. 결제 완료 (Sponsor → 쿠팡)
   └─> 무통장입금 완료

7. 완료 확인 (Customer)
   └─> 쿠팡에서 입금 확인, 상태 업데이트
```

### 릴레이 모델 (NIP-65 Outbox)

```
                    앱 pubkey의 kind 10002에서 read relay 파싱
                                    │
                                    ▼
              ┌──────────────────────────────────────┐
              │         App의 Read Relays             │
              │  (wss://relay1.com, wss://relay2.com) │
              └──────────────────────────────────────┘
                    ▲                        │
                    │                        │
              Customer WRITE           Sponsor READ
              (사줘 요청 발행)          (사줘 요청 구독)
```

- Admin이 앱 pubkey의 kind 10002 이벤트를 업데이트하면 릴레이 목록이 변경된다.
- Customer는 10분마다 갱신하여 변경을 반영한다.
- 이벤트 프로토콜 상세는 [PROTOCOL.md](PROTOCOL.md) 참조.

### 사용 라이브러리

- **nostr-tools**: Nostr 프로토콜 구현 라이브러리
  - 버전: 2.23.0+
  - `nostr-tools/pure` (키 생성/서명), `nostr-tools/pool` (SimplePool)

## 각 앱별 역할

### Customer App (고객용)

- 쿠팡 주문 페이지 파싱 및 무통장입금 주문 감지
- 주문 상태 관리 (상태 머신 기반)
- Nostr를 통한 사줘 요청 발송 (kind 30078 addressable event)
- 클레이머 응답 수신 및 선택
- 입금 완료 자동 감지

#### Customer 모듈 구조

```
customer/src/
  background/index.ts   - Nostr 초기화, 릴레이 갱신 알람, 메시지 핸들러
  content/index.ts      - 쿠팡 페이지 파싱, 주문 감지
  nostr/
    constants.ts        - 앱 pubkey, kind 번호, 상수
    keys.ts             - 키페어 생성/저장/조회
    relays.ts           - NIP-65 릴레이 디스커버리, 캐싱
    events.ts           - 사줘 요청 이벤트 빌드 (NIP-33, NIP-40)
    publish.ts          - SimplePool 기반 브로드캐스트
  shared/
    types.ts            - TrackedOrder, 상태 전이 타입 등
    storage.ts          - chrome.storage.local CRUD
    state-machine.ts    - 상태 전이 (optimistic locking)
    filter.ts           - 쿠팡 데이터 파싱
```

### Sponsor App (후원자용)

- Nostr에서 사줘 요청 구독
- 요청 목록 표시 및 필터링
- 클레임 응답 발송
- 결제 안내 수신
- 결제 내역 관리

### Admin App (관리자용)

- 시스템 모니터링
- 사용자 관리
- 분쟁 해결
- 통계 및 리포트

## 기술 스택

| 영역 | 기술 |
|------|------|
| 언어 | TypeScript |
| 프레임워크 | Chrome Extension (Manifest V3) |
| 빌드 | Vite + CRXJS |
| 통신 | Nostr (nostr-tools) |
| 저장소 | chrome.storage.local |
| 테스트 | Vitest |

## 관련 문서

- [PROTOCOL.md](PROTOCOL.md) - Nostr 이벤트 프로토콜 명세 (3개 앱 공통)
- [TODO.md](TODO.md) - 향후 구현 계획
