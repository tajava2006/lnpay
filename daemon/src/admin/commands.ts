/**
 * 운영자 명령 (PLAN-DAEMON §5)
 *
 * 어드민 앱은 **운영자 키**로 서명한 명령만 보낸다. 데몬은 네 가지를 확인한 뒤 집행한다:
 *
 * 1. 보낸 사람이 운영자 목록에 있는가
 * 2. 10분 안에 만든 명령인가 — 폰에서 눌러놓고 한참 뒤 전달된 명령이 뒤늦게 집행되지 않게
 * 3. 한 번만 (이벤트 id — 수신 계층이 이미 거른다, DM-004)
 * 4. 오더를 바꾸는 명령이면 명령이 본 오더 버전이 지금과 같은가 (DM-006, P2부터)
 *
 * 결과는 운영자에게 암호화해 돌려준다. 거절도 돌려준다 — 조용히 버리면 어드민 화면은 "처리 중"에서
 * 영영 안 넘어간다.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { SAJWO_REQUEST_EVENT_KIND, nip44Decrypt, nip44Encrypt } from '@sajwo-tracker/shared/core';
import type { Db } from '../db';
import type { Effects } from '../effects';
import type { InboxEvent, HandlerResult } from '../dispatch';
import type { AppKey } from '../secrets';
import { PUBLISH_EFFECT, type PublishPayload } from '../nostr/publisher';

/** 명령 이벤트의 action 태그 */
export const ADMIN_COMMAND = 'admin-command';
/** 결과 이벤트의 action 태그 */
export const ADMIN_RESULT = 'admin-result';

/** 이보다 오래된 명령은 집행하지 않는다 */
export const COMMAND_TTL_SEC = 10 * 60;
/** 미래 시각 허용 폭 (시계 차이) */
const FUTURE_SKEW_SEC = 5 * 60;

export interface CommandPayload {
  cmd: string;
  args?: Record<string, unknown>;
}

export type CommandResult =
  | { ok: true; cmd: string; result: unknown }
  | { ok: false; cmd: string; error: string };

export interface AdminDeps {
  db: Db;
  effects: Effects;
  appKey: AppKey;
  operators: ReadonlySet<string>;
  adminTag: string;
  nowMs: () => number;
  version: string;
}

function isCommandPayload(value: unknown): value is CommandPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.cmd !== 'string' || v.cmd.length === 0) return false;
  return v.args === undefined || (typeof v.args === 'object' && v.args !== null);
}

export function createAdminHandler(deps: AdminDeps): (event: InboxEvent) => HandlerResult {
  return event => {
    if (!deps.operators.has(event.pubkey)) return { outcome: 'ignored', reason: 'not-operator' };

    const nowSec = Math.floor(deps.nowMs() / 1000);
    if (event.created_at < nowSec - COMMAND_TTL_SEC) return { outcome: 'ignored', reason: 'stale-command' };
    if (event.created_at > nowSec + FUTURE_SKEW_SEC) return { outcome: 'ignored', reason: 'future-command' };

    let payload: unknown;
    try {
      payload = JSON.parse(nip44Decrypt(event.content, deps.appKey.secretKey, event.pubkey));
    } catch {
      return { outcome: 'ignored', reason: 'undecryptable' };
    }
    if (!isCommandPayload(payload)) {
      reply(deps, event, { ok: false, cmd: '?', error: 'bad-payload' });
      return { outcome: 'ok' };
    }

    reply(deps, event, execute(deps, payload));
    return { outcome: 'ok' };
  };
}

/** 명령 표. P2에서 `config.set`·`chat.send`, P3·P4에서 트랙별 명령이 붙는다 (§5.5) */
function execute(deps: AdminDeps, payload: CommandPayload): CommandResult {
  switch (payload.cmd) {
    case 'ping':
      return { ok: true, cmd: 'ping', result: { pong: Math.floor(deps.nowMs() / 1000), version: deps.version } };
    default:
      return { ok: false, cmd: payload.cmd, error: 'unknown-command' };
  }
}

/** 결과를 운영자에게 — 서명은 지금 한 번, 발행은 효과 대기열이 재시도한다 */
function reply(deps: AdminDeps, command: InboxEvent, result: CommandResult): void {
  const nowSec = Math.floor(deps.nowMs() / 1000);
  const event = finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: nowSec,
    tags: [
      ['p', command.pubkey],
      ['e', command.id],
      ['t', deps.adminTag],
      ['action', ADMIN_RESULT],
      ['expiration', String(nowSec + COMMAND_TTL_SEC)],
    ],
    content: nip44Encrypt(JSON.stringify(result), deps.appKey.secretKey, command.pubkey),
  }, deps.appKey.secretKey);
  deps.effects.enqueue<PublishPayload>(PUBLISH_EFFECT, { event }, { dedup: `admin-result:${command.id}` });
}
