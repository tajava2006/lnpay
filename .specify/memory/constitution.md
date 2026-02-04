<!--
Sync Impact Report
==================
Version change: N/A → 1.0.0 (initial)
Added sections: Core Principles (5), Technology Stack, Development Workflow, Governance
Removed sections: None (initial creation)
Templates requiring updates:
  ✅ .specify/templates/plan-template.md - no changes needed
  ✅ .specify/templates/spec-template.md - no changes needed
  ✅ .specify/templates/tasks-template.md - no changes needed
Follow-up TODOs: None
-->

# Web Parser Chrome Extension Constitution

## Core Principles

### I. TypeScript First

모든 코드는 TypeScript로 작성한다.
- 모든 소스 파일은 `.ts` 또는 `.tsx` 확장자 사용 필수
- `strict` 모드 활성화 필수 (`tsconfig.json`)
- `any` 타입 사용 금지 (불가피한 경우 `unknown` + 타입 가드 사용)
- 외부 라이브러리는 `@types/*` 패키지가 있는 것 우선 선택

### II. Manifest V3

Chrome Extension Manifest V3 API를 사용한다.
- Service Worker 기반 background script 사용 (persistent background page 금지)
- `chrome.scripting` API로 content script 주입
- 권한은 필요한 최소한만 요청 (`activeTab` 우선, `<all_urls>` 지양)
- CSP(Content Security Policy) 준수

### III. Test Required

핵심 비즈니스 로직은 반드시 테스트한다.
- 파싱 로직, 데이터 변환, 유틸리티 함수는 단위 테스트 필수
- UI 컴포넌트 테스트는 선택적
- 테스트 프레임워크: Vitest 권장
- 테스트 커버리지 목표: 핵심 로직 80% 이상

### IV. Modular Architecture

역할별로 모듈을 분리한다.
- `src/background/` - Service Worker (이벤트 처리, 스토리지 관리)
- `src/content/` - Content Script (DOM 조작, 페이지 파싱)
- `src/popup/` - Popup UI (사용자 인터페이스)
- `src/shared/` - 공유 타입, 유틸리티, 상수
- 각 모듈 간 통신은 `chrome.runtime.sendMessage` 사용

### V. Security First

보안을 최우선으로 고려한다.
- 사용자 데이터는 `chrome.storage.local`에만 저장
- 외부 서버 통신 시 HTTPS 필수
- `eval()`, `innerHTML` 직접 사용 금지
- 민감 정보(API 키 등)는 코드에 하드코딩 금지

### VI. Nostr Protocol

탈중앙화 통신 프로토콜 Nostr를 사용한다.
- 모든 사용자 간 통신은 Nostr 이벤트를 통해 수행
- 라이브러리: `nostr-tools` (latest)
- 개인키는 안전하게 저장 (chrome.storage.local, 암호화 권장)
- 릴레이 연결 실패 시 graceful degradation 처리
- Nostr 관련 코드는 `src/shared/nostr/` 디렉토리에 모듈화

## System Context

이 레포지토리는 "사줘 트래커" 시스템의 **고객용 앱**이다.
- 전체 시스템 아키텍처: `../ARCHITECTURE.md` 참조
- 관련 레포: `sponsor/` (후원자용), `admin/` (관리자용)

## Technology Stack

- **Language**: TypeScript 5.x
- **Build Tool**: Vite + CRXJS (Chrome Extension 빌드 지원)
- **Package Manager**: pnpm
- **Testing**: Vitest
- **Linting**: ESLint + Prettier
- **Target**: Chrome 120+ (Manifest V3)
- **Communication**: Nostr (nostr-tools 2.x)

## Development Workflow

1. **기능 개발 시작 전**: spec.md 작성으로 요구사항 명확화
2. **구현 전**: plan.md로 기술적 설계 수립
3. **구현 중**: tasks.md 체크박스로 진행 상황 추적
4. **PR 전**: 테스트 통과 확인, 린트 에러 없음

## Governance

- 이 Constitution은 모든 개발 결정의 최상위 기준이다
- 원칙 수정 시 MAJOR 버전 변경 및 문서화 필수
- 예외 상황 발생 시 해당 PR에 사유 명시

**Version**: 1.1.0 | **Ratified**: 2026-01-28 | **Last Amended**: 2026-02-04
