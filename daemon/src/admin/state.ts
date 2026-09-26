/**
 * 운영자 상태 발행
 *
 * `ADMIN_STATE_KIND`, 운영자마다 d 하나. 내용은 **발행하는 순간의** DB로 만든다 — 대기열에 쌓인 뒤 바뀐 것까지
 * 실린다. 그래서 "상태를 다시 내라"는 의도는 운영자당 하나로 합친다(dedup).
 *
 * 설정·경보가 바뀔 때와, 하트비트로 주기적으로 낸다. 어드민 화면은 `heartbeatAt`이 오래되면
 * "데몬 응답 없음"을 띄운다.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import {
  ADMIN_STATE_KIND, PROTOCOL_VERSION, adminStateDTag, nip44Encrypt, type AdminState,
} from '@sajwo-tracker/shared/core';
import { ONCHAIN_WINDOWS } from '@sajwo-tracker/shared/onchain';
import type { EffectExecutor } from '../effects';
import type { RelayTransport } from '../nostr/transport';
import { openAlerts } from './alerts';
import { nowSec, type AdminContext } from './context';
import { loadSettings } from './settings';

export const STATE_EFFECT = 'admin.state';

/** 하트비트 주기 — `ADMIN_STATE_STALE_SEC`(5분)보다 충분히 짧게 */
export const STATE_INTERVAL_MS = 60_000;

/** 상태 이벤트 보존 — 데몬이 죽으면 하루 뒤 릴레이에서 사라진다(화면은 그 전에 이미 "응답 없음") */
const STATE_RETENTION_SEC = 24 * 60 * 60;

interface StatePayload {
  operator: string;
}

export function requestStatePublish(ctx: AdminContext): void {
  for (const operator of ctx.operators) {
    ctx.effects.enqueue<StatePayload>(STATE_EFFECT, { operator }, { dedup: `admin-state:${operator}` });
  }
}

export function buildAdminState(ctx: AdminContext): AdminState {
  const counts = ctx.db.get<{ pending: number; dead: number }>(
    `SELECT SUM(status = 'pending') AS pending, SUM(status = 'dead') AS dead FROM effects`,
  );
  return {
    v: 1,
    daemonVersion: ctx.version,
    protocol: PROTOCOL_VERSION,
    mode: ctx.mode,
    startedAt: ctx.startedAt,
    epoch: ctx.epoch,
    onchainWindows: { ...ONCHAIN_WINDOWS },
    heartbeatAt: nowSec(ctx),
    relays: [...ctx.relays],
    settings: loadSettings(ctx.db),
    alerts: openAlerts(ctx),
    effects: { pending: Number(counts?.pending ?? 0), dead: Number(counts?.dead ?? 0) },
  };
}

export function createStateExecutor(ctx: AdminContext, transport: RelayTransport): EffectExecutor<StatePayload> {
  return {
    async run({ operator }) {
      if (!ctx.operators.includes(operator)) return { status: 'dead', error: '운영자 목록에서 빠졌다' };
      const dTag = adminStateDTag(ctx.tags.admin, operator);
      // addressable 이벤트는 created_at이 같으면 id가 작은 쪽이 남는다(NIP-01) — 같은 초 두 발행에서
      // 옛 상태가 남지 않게 단조 증가시킨다
      const last = Number(ctx.db.kvGet(`state.createdAt:${operator}`) ?? 0);
      const createdAt = Math.max(nowSec(ctx), last + 1);
      const event = finalizeEvent({
        kind: ADMIN_STATE_KIND,
        created_at: createdAt,
        tags: [
          ['d', dTag],
          ['p', operator],
          ['t', ctx.tags.admin],
          ['expiration', String(createdAt + STATE_RETENTION_SEC)],
        ],
        content: nip44Encrypt(JSON.stringify(buildAdminState(ctx)), ctx.appKey.secretKey, operator),
      }, ctx.appKey.secretKey);

      const report = await transport.publish(event);
      if (report.accepted.length === 0) {
        return { status: 'retry', error: report.rejected.map(r => r.reason).join('; ') || '릴레이 없음' };
      }
      return { status: 'done', result: { createdAt } };
    },
    onDone({ operator }, result) {
      const createdAt = (result as { createdAt: number }).createdAt;
      ctx.db.kvSet(`state.createdAt:${operator}`, String(createdAt));
    },
  };
}
