/**
 * 운영자 ↔ 데몬 약속 (PLAN-DAEMON §5)
 *
 * 어드민 앱은 **운영자 키**로 명령을 보내고, 데몬은 APP 키로 결과·상태·채팅 사본을 돌려준다.
 * 두 쪽이 같은 모양을 보도록 여기 한 곳에 둔다 — 한쪽만 고치면 명령이 조용히 안 먹는다.
 *
 * | 무엇 | 이벤트 | 방향 |
 * |---|---|---|
 * | 명령 | kind 1111 · `action=admin-command` · `p=APP` | 운영자 → 데몬 |
 * | 결과 | kind 1111 · `action=admin-result` · `p=운영자` · `e=명령` | 데몬 → 운영자 |
 * | 채팅 사본 | kind 1111 · `action=admin-chat` · `p=운영자` | 데몬 → 운영자 |
 * | 상태 | kind 30078 · `d=adminStateDTag(…)` | 데몬 → 운영자 |
 *
 * 전부 NIP-44 암호문이고 `t`는 어드민 태그(`CLIENT_TAG_ADMIN`)다.
 */
import type { DisputeMessagePayload } from './types';

export const ADMIN_ACTIONS = {
  COMMAND: 'admin-command',
  RESULT: 'admin-result',
  CHAT: 'admin-chat',
} as const;

/** 이보다 오래된 명령은 집행하지 않는다 — 폰에서 눌러놓고 한참 뒤 전달된 명령 */
export const ADMIN_COMMAND_TTL_SEC = 10 * 60;

/** 데몬 상태 이벤트 (NIP-78) */
export const ADMIN_STATE_KIND = 30078;

/** 운영자마다 따로 둔다 — 한 d에 여러 수신자를 쓰면 서로 덮는다 */
export function adminStateDTag(adminTag: string, operatorPubkey: string): string {
  return `lnpay-admin:${adminTag}:state:${operatorPubkey}`;
}

// ── 명령 ─────────────────────────────────────────────────────

export type TrackName = 'ln' | 'onchain';

export interface AdminCommand {
  cmd: string;
  args?: Record<string, unknown>;
}

export type AdminCommandResult =
  | { ok: true; cmd: string; result: unknown }
  | { ok: false; cmd: string; error: string };

/**
 * 오더를 바꾸는 명령이 싣는 것 (DM-006). `version`이 데몬의 지금 버전과 다르면 거절된다 —
 * 낡은 화면에서 누른 판정이 되돌릴 수 없는 몰수부터 집행하는 걸 막는다.
 */
export interface OrderTarget {
  track: TrackName;
  orderId: string;
  version: number;
}

// ── 설정 ─────────────────────────────────────────────────────

/**
 * 운영 중에 바꾸는 값. 네트워크·체인 API·LN 접속처럼 배포에 묶인 값은 여기 없다 — 데몬 환경변수다.
 */
export interface DaemonSettings {
  ln: {
    /** `claimed → verified` 자동 승인 */
    autoApprove: boolean;
    /** 고객 보증금 (의뢰 금액 대비 %) */
    customerDepositPct: number;
    /** 후원자 보증금 (%) */
    sponsorDepositPct: number;
  };
  onchain: {
    /** 새 의뢰를 받는가. 끄더라도 진행 중인 거래는 끝까지 간다 */
    acceptNewOrders: boolean;
  };
}

export const DEFAULT_SETTINGS: DaemonSettings = {
  ln: { autoApprove: true, customerDepositPct: 0, sponsorDepositPct: 0 },
  onchain: { acceptNewOrders: false },
};

/** 보증금 비율 상한 — 넘으면 오타일 가능성이 크다 */
export const MAX_DEPOSIT_PCT = 20;

/**
 * 설정 일부를 덮어쓴다. 모르는 키·틀린 타입은 **통째로 거부**한다 — 반만 적용된 설정이 제일 위험하다.
 */
export function applySettingsPatch(
  current: DaemonSettings,
  patch: unknown,
): { ok: true; settings: DaemonSettings } | { ok: false; error: string } {
  if (!isRecord(patch)) return { ok: false, error: 'patch는 객체여야 한다' };
  const next: DaemonSettings = { ln: { ...current.ln }, onchain: { ...current.onchain } };

  for (const [section, value] of Object.entries(patch)) {
    if (section !== 'ln' && section !== 'onchain') return { ok: false, error: `모르는 설정: ${section}` };
    if (!isRecord(value)) return { ok: false, error: `${section}는 객체여야 한다` };
    for (const [key, v] of Object.entries(value)) {
      const problem = section === 'ln' ? setLn(next.ln, key, v) : setOnchain(next.onchain, key, v);
      if (problem) return { ok: false, error: problem };
    }
  }
  return { ok: true, settings: next };
}

function setLn(target: DaemonSettings['ln'], key: string, v: unknown): string | null {
  switch (key) {
    case 'autoApprove':
      if (typeof v !== 'boolean') return 'ln.autoApprove는 true/false';
      target.autoApprove = v;
      return null;
    case 'customerDepositPct':
    case 'sponsorDepositPct':
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_DEPOSIT_PCT) {
        return `ln.${key}는 0~${MAX_DEPOSIT_PCT}`;
      }
      target[key] = Math.round(v * 100) / 100;
      return null;
    default:
      return `모르는 설정: ln.${key}`;
  }
}

function setOnchain(target: DaemonSettings['onchain'], key: string, v: unknown): string | null {
  if (key !== 'acceptNewOrders') return `모르는 설정: onchain.${key}`;
  if (typeof v !== 'boolean') return 'onchain.acceptNewOrders는 true/false';
  target.acceptNewOrders = v;
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── 상태 ─────────────────────────────────────────────────────

export interface AdminAlert {
  id: number;
  level: 'warn' | 'anomaly';
  track?: TrackName;
  orderId?: string;
  message: string;
  raisedAt: number;
}

/** 데몬이 운영자에게 주기적으로(그리고 바뀔 때) 내는 요약 */
export interface AdminState {
  v: 1;
  daemonVersion: string;
  mode: 'prod' | 'dev';
  startedAt: number;
  /** 이 상태를 만든 시각 — 어드민 화면은 이게 오래되면 "데몬 응답 없음"을 띄운다 */
  heartbeatAt: number;
  relays: string[];
  settings: DaemonSettings;
  /** 아직 확인하지 않은 경보 */
  alerts: AdminAlert[];
  effects: { pending: number; dead: number };
}

/** 상태 이벤트가 이만큼 안 오면 데몬이 죽은 것으로 본다 (발행 주기의 몇 배) */
export const ADMIN_STATE_STALE_SEC = 5 * 60;

// ── 채팅 사본 ────────────────────────────────────────────────

/**
 * 분쟁 채팅은 APP 키와 유저 사이의 NIP-44라 운영자 키로는 못 읽는다. 데몬이 풀어서 운영자에게 다시
 * 암호화해 보낸다(§5.4) — 들어온 것도, 어드민이 보낸 것도.
 */
export interface AdminChatCopy {
  track: TrackName;
  orderId: string;
  /** 보낸 사람. APP이면 어드민(운영자)이 보낸 것 */
  from: string;
  to: string;
  /** 보낸 사람이 그 오더의 누구인지. 데몬이 모르는 오더면 없다 */
  role?: 'customer' | 'sponsor' | 'admin';
  payload: DisputeMessagePayload;
  sentAt: number;
  /** 원래 dispute-message 이벤트 id — 같은 메시지를 두 번 그리지 않게 */
  originalId: string;
}

/** 텍스트 한 통의 상한 — 넘으면 거절(오입력·붙여넣기 사고) */
export const MAX_CHAT_TEXT = 2000;
