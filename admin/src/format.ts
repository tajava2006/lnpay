/**
 * 어드민 화면의 공용 문구 — 명령 결과, pubkey·금액 표기
 */
import { nip19 } from 'nostr-tools';
import {
  PROTOCOL_VERSION, type AdminCommandResult, type AdminLnOrderDetail, type AdminState, type OrderState,
} from '@sajwo-tracker/shared';
import { LN_PAYOUT_INVOICE_EXPIRED, LN_PAYOUT_MANUAL, LN_PAYOUT_MANUAL_REQUESTED } from '@sajwo-tracker/shared/ln';

/** 데몬이 돌려주는 거절 사유 중 사람이 읽어야 하는 것 */
const REJECT_TEXT: Record<string, string> = {
  'stale-version': '그 사이 오더가 바뀌었습니다(다른 기기·유저·체인). 상세를 다시 보고 판단하세요',
  'no-fees': '데몬이 네트워크 수수료를 아직 모릅니다 — 잠시 후 다시',
  'not-manual': '데몬이 아직 자동 지급 멈춤을 확인하지 않았습니다 — "직접 처리"로 바뀐 뒤에 누르세요',
  'already-manual': '이미 자동 지급을 멈췄습니다',
  'already-disbursed': '이미 지급됐습니다',
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
 * 라이트닝 공개 보증금이 꺼져 있나 — 꺼져 있으면 공개 오더북이 무담보다(docs/RISKS.md R-5). 코드로
 * 막지는 않는다(운영 설정). 보증금 없이 거래하고 싶은 사람은 지정 거래로 가면 된다. 상태를 모르면 말하지 않는다.
 */
export function depositWarnings(state: Pick<AdminState, 'settings'> | null): string[] {
  if (!state) return [];
  const { ln } = state.settings;
  const out: string[] = [];
  if (ln.sponsorDepositPct === 0) {
    out.push('라이트닝 후원자 보증금 0% — 공개 의뢰를 누구나 공짜로 찜하고 잠수탈 수 있습니다(고객 BTC가 묶입니다). '
      + '보증금 없는 거래는 지정 거래가 맡습니다.');
  }
  if (ln.customerDepositPct === 0) {
    out.push('라이트닝 고객 보증금 0% — 공개 의뢰를 공짜로 올릴 수 있습니다(오더북 스팸).');
  }
  return out;
}

/**
 * 후원자 지급 단계 — 상태마다 못박는다(새 상태를 넣으면 빌드가 깨진다).
 * later = 아직 지급할 때가 아니다(고객 확인·판정 전) · due = 지급 사유로 닫혔다 · none = 지급 없이 닫혔다
 */
const PAYOUT_PHASE: Record<OrderState, 'later' | 'due' | 'none'> = {
  requested: 'later', claimed: 'later', verified: 'later', escrowed: 'later', invoiced: 'later', remitted: 'later',
  paid: 'due', sponsor_wins: 'due',
  cancelled: 'none', expired: 'none', admin_closed: 'none', customer_wins: 'none',
};

/**
 * 오더 상세의 "지급" 한 줄. "대기"라고만 하면 **아직 때가 아닌 것**과 **지급하려다 멈춘 것**이 섞인다 —
 * 멈춘 것도 인보이스 만료(후원자가 새로 내야 한다)와 결제 실패(데몬이 다시 한다)를 가른다.
 */
export function lnPayoutText(
  d: Pick<AdminLnOrderDetail, 'state' | 'disbursed' | 'sponsorInvoice' | 'payoutError'>,
): { text: string; warn: boolean } {
  if (d.disbursed) return { text: d.payoutError === LN_PAYOUT_MANUAL ? '완료 (운영자가 직접 결제)' : '완료', warn: false };
  switch (PAYOUT_PHASE[d.state]) {
    case 'none':
      return { text: '없음 — 후원자에게 지급하지 않고 닫힌 거래', warn: false };
    case 'later':
      return {
        text: `아직 아님 — 고객 확인(또는 판정) 뒤에 나갑니다 · ${d.sponsorInvoice ? '인보이스 등록됨' : '인보이스 미등록'}`,
        warn: false,
      };
    case 'due':
      if (d.payoutError === LN_PAYOUT_MANUAL_REQUESTED) {
        return { text: '멈추는 중 — 데몬이 지금 인보이스가 안 나갔는지 확인하고 있습니다. "직접 처리"로 바뀌기 전에 직접 결제하면 두 번 나갈 수 있습니다', warn: true };
      }
      if (d.payoutError === LN_PAYOUT_MANUAL) {
        return { text: '직접 처리 — 데몬은 이 거래에 더 결제하지 않습니다(지금 인보이스가 안 나간 걸 확인함). 노드에서 직접 결제한 뒤 "지급 완료로 기록"을 누르세요', warn: true };
      }
      if (d.payoutError === LN_PAYOUT_INVOICE_EXPIRED) {
        return { text: '멈춤 — 후원자 인보이스가 만료돼 새 인보이스를 기다립니다(후원자에게 알림 보냄). BTC는 데몬에 있습니다', warn: true };
      }
      if (d.payoutError) {
        return { text: `실패 — ${d.payoutError}. 데몬이 다시 하는 중이면 "지급 지금 다시"로 앞당길 수 있습니다`, warn: true };
      }
      return { text: '보내는 중', warn: false };
  }
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

