/**
 * 어드민 화면의 공용 문구 — 명령 결과, pubkey·금액 표기
 */
import { nip19 } from 'nostr-tools';
import { PROTOCOL_VERSION, type AdminCommandResult, type AdminState } from '@sajwo-tracker/shared';

/** 데몬이 돌려주는 거절 사유 중 사람이 읽어야 하는 것 */
const REJECT_TEXT: Record<string, string> = {
  'stale-version': '그 사이 오더가 바뀌었습니다(다른 기기·유저·체인). 상세를 다시 보고 판단하세요',
  'no-fees': '데몬이 네트워크 수수료를 아직 모릅니다 — 잠시 후 다시',
};

/**
 * 명령 결과 한 줄.
 *
 * 결과가 안 온 건 "실패"가 아니라 **모름**이다 — 집행됐을 수 있으니 다시 누르기 전에 상태를 본다.
 */
export function commandResultText(
  result: AdminCommandResult | null,
  opts: { done?: string; unknown?: string } = {},
): string {
  if (!result) return `데몬 응답 없음 — ${opts.unknown ?? '집행됐는지 모릅니다. 상세가 갱신되는지 보고 판단하세요'}`;
  if (result.ok) return opts.done ?? '완료';
  return `거절: ${REJECT_TEXT[result.error] ?? result.error}`;
}

/** 오더 상세(운영자용)가 아직 안 왔을 때 — 명령은 버전이 있어야 보낼 수 있다(DM-006) */
export const WAITING_DETAIL_TEXT = '데몬 상세를 기다리는 중… (명령은 상세가 와야 보낼 수 있습니다)';

/** pubkey를 짧은 npub으로 */
export function shortNpub(pubkey: string | undefined): string {
  return pubkey ? `${nip19.npubEncode(pubkey).slice(0, 14)}…` : '—';
}

export function satsText(n: number | undefined): string {
  return n === undefined ? '—' : `${n.toLocaleString()} sats`;
}

/**
 * 데몬과 이 앱의 프로토콜이 다른가 — 한쪽만 배포했다(`PROTOCOL_VERSION`). 같으면 null.
 * 상태를 아직 못 받았으면 모르는 것이라 말하지 않는다.
 */
export function protocolWarning(state: Pick<AdminState, 'protocol'> | null): string | null {
  if (!state) return null;
  const daemon = state.protocol;
  if (daemon === PROTOCOL_VERSION) return null;
  if (daemon === undefined) {
    return '데몬이 프로토콜 버전을 싣기 전의 옛 빌드입니다 — 데몬 이미지를 다시 빌드하세요.';
  }
  return daemon < PROTOCOL_VERSION
    ? `데몬(프로토콜 ${daemon})이 이 앱(${PROTOCOL_VERSION})보다 옛것입니다 — 데몬 이미지를 다시 빌드하세요 `
      + '(docker compose build lnpay-daemon 뒤 재시작).'
    : `이 앱(프로토콜 ${PROTOCOL_VERSION})이 데몬(${daemon})보다 옛것입니다 — 새로고침하거나 앱을 배포하세요(pnpm ship).`;
}

