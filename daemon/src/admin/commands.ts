/**
 * 운영자 명령 (PLAN-DAEMON §5)
 *
 * 어드민 앱은 **운영자 키**로 서명한 명령만 보낸다. 데몬은 네 가지를 확인한 뒤 집행한다:
 *
 * 1. 보낸 사람이 운영자 목록에 있는가
 * 2. 10분 안에 만든 명령인가 — 폰에서 눌러놓고 한참 뒤 전달된 명령이 뒤늦게 집행되지 않게
 * 3. 한 번만 (이벤트 id — 수신 계층이 이미 거른다, DM-004)
 * 4. 오더를 바꾸는 명령이면 명령이 본 오더 버전이 지금과 같은가 (DM-006 — `checkTarget`)
 *
 * 결과는 운영자에게 암호화해 돌려준다. 거절도 돌려준다 — 조용히 버리면 어드민 화면은 "처리 중"에서
 * 영영 안 넘어간다.
 *
 * 트랙별 명령(판정·강제 종결 등)은 P3·P4에서 `register`로 붙는다.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import {
  ADMIN_ACTIONS, ADMIN_COMMAND_TTL_SEC, SAJWO_REQUEST_EVENT_KIND, applySettingsPatch,
  nip44Decrypt, nip44Encrypt, type AdminCommand, type AdminCommandResult,
} from '@sajwo-tracker/shared/core';
import type { HandlerResult, InboxEvent } from '../dispatch';
import { PUBLISH_EFFECT, type PublishPayload } from '../nostr/publisher';
import { ackAlert } from './alerts';
import { chatSend } from './chat';
import { nowSec, type AdminContext } from './context';
import { loadSettings, saveSettings } from './settings';
import { requestStatePublish } from './state';

/** 미래 시각 허용 폭 (시계 차이) */
const FUTURE_SKEW_SEC = 5 * 60;

/**
 * 명령 하나. **트랜잭션 안에서, 네트워크 없이** 돈다(디스패처가 연다). 외부 효과는 의도만 쌓는다.
 */
export type CommandHandler = (ctx: AdminContext, args: Record<string, unknown>) => AdminCommandResult;

export class CommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();

  register(cmd: string, handler: CommandHandler): void {
    if (this.handlers.has(cmd)) throw new Error(`명령 중복 등록: ${cmd}`);
    this.handlers.set(cmd, handler);
  }

  execute(ctx: AdminContext, command: AdminCommand): AdminCommandResult {
    const handler = this.handlers.get(command.cmd);
    if (!handler) return { ok: false, cmd: command.cmd, error: 'unknown-command' };
    return handler(ctx, command.args ?? {});
  }
}

/** 트랙과 무관한 기본 명령 */
export function createBaseCommands(): CommandRegistry {
  const registry = new CommandRegistry();

  registry.register('ping', ctx => ({
    ok: true, cmd: 'ping', result: { pong: nowSec(ctx), version: ctx.version },
  }));

  registry.register('config.get', ctx => ({ ok: true, cmd: 'config.get', result: loadSettings(ctx.db) }));

  registry.register('config.set', (ctx, args) => {
    const applied = applySettingsPatch(loadSettings(ctx.db), args.patch);
    if (!applied.ok) return { ok: false, cmd: 'config.set', error: applied.error };
    saveSettings(ctx.db, applied.settings);
    requestStatePublish(ctx);
    ctx.log.info('설정 변경', { settings: applied.settings });
    return { ok: true, cmd: 'config.set', result: applied.settings };
  });

  registry.register('alert.ack', (ctx, args) => {
    if (!Number.isInteger(args.id)) return { ok: false, cmd: 'alert.ack', error: 'bad-args' };
    return ackAlert(ctx, args.id as number)
      ? { ok: true, cmd: 'alert.ack', result: { id: args.id } }
      : { ok: false, cmd: 'alert.ack', error: 'unknown-or-acked' };
  });

  registry.register('chat.send', chatSend);

  return registry;
}

function isAdminCommand(value: unknown): value is AdminCommand {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.cmd !== 'string' || v.cmd.length === 0) return false;
  return v.args === undefined || (typeof v.args === 'object' && v.args !== null && !Array.isArray(v.args));
}

export function createAdminHandler(ctx: AdminContext, registry: CommandRegistry): (event: InboxEvent) => HandlerResult {
  const operators = new Set(ctx.operators);
  return event => {
    if (!operators.has(event.pubkey)) return { outcome: 'ignored', reason: 'not-operator' };

    const now = nowSec(ctx);
    if (event.created_at < now - ADMIN_COMMAND_TTL_SEC) return { outcome: 'ignored', reason: 'stale-command' };
    if (event.created_at > now + FUTURE_SKEW_SEC) return { outcome: 'ignored', reason: 'future-command' };

    let payload: unknown;
    try {
      payload = JSON.parse(nip44Decrypt(event.content, ctx.appKey.secretKey, event.pubkey));
    } catch {
      return { outcome: 'ignored', reason: 'undecryptable' };
    }

    const result: AdminCommandResult = isAdminCommand(payload)
      ? registry.execute(ctx, payload)
      : { ok: false, cmd: '?', error: 'bad-payload' };
    reply(ctx, event, result);
    return { outcome: 'ok' };
  };
}

/** 결과를 운영자에게 — 서명은 지금 한 번, 발행은 효과 대기열이 재시도한다 */
function reply(ctx: AdminContext, command: InboxEvent, result: AdminCommandResult): void {
  const createdAt = nowSec(ctx);
  const event = finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: createdAt,
    tags: [
      ['p', command.pubkey],
      ['e', command.id],
      ['t', ctx.tags.admin],
      ['action', ADMIN_ACTIONS.RESULT],
      ['expiration', String(createdAt + ADMIN_COMMAND_TTL_SEC)],
    ],
    content: nip44Encrypt(JSON.stringify(result), ctx.appKey.secretKey, command.pubkey),
  }, ctx.appKey.secretKey);
  ctx.effects.enqueue<PublishPayload>(PUBLISH_EFFECT, { event }, { dedup: `admin-result:${command.id}` });
}
