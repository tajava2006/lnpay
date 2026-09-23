/**
 * 데몬에 명령 보내기 (PLAN-DAEMON §5.2)
 *
 * 운영자 키로 서명하고 APP에게 NIP-44로 암호화한다. 결과는 피드(`feed.ts`)가 받아 이 약속을 푼다.
 *
 * 결과가 안 오면 **"데몬 응답 없음"**으로 끝낸다 — 명령이 집행됐는지 모르는 상태를 "실패"로 적으면
 * 안 된다(재전송하면 두 번 집행될 수 있다). 늦게 온 결과는 그대로 반영한다.
 */
import type { EventTemplate } from 'nostr-tools/core';
import { SimplePool } from 'nostr-tools/pool';
import {
  ADMIN_ACTIONS, ADMIN_COMMAND_TTL_SEC, APP_PUBKEY, CLIENT_TAG_ADMIN, SAJWO_REQUEST_EVENT_KIND,
  getReadRelays, storage, type AdminCommandResult,
} from '@sajwo-tracker/shared';
import { getSigner } from '../nostr/nip46';
import { commands } from './stores';

/** 이만큼 결과가 없으면 "응답 없음" (데몬은 새 명령을 몇 초 안에 처리한다) */
const RESULT_TIMEOUT_MS = 60_000;

const waiting = new Map<string, (result: AdminCommandResult) => void>();

export async function sendCommand(cmd: string, args?: Record<string, unknown>): Promise<AdminCommandResult | null> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음');

  const createdAt = Math.floor(Date.now() / 1000);
  const content = await signer.nip44Encrypt(APP_PUBKEY, JSON.stringify(args ? { cmd, args } : { cmd }));
  const template: EventTemplate = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: createdAt,
    tags: [
      ['p', APP_PUBKEY],
      ['t', CLIENT_TAG_ADMIN],
      ['action', ADMIN_ACTIONS.COMMAND],
      ['expiration', String(createdAt + ADMIN_COMMAND_TTL_SEC)],
    ],
    content,
  };
  const signed = await signer.signEvent(template);
  commands.update(prev => ({ ...prev, [signed.id]: { id: signed.id, cmd, sentAt: createdAt, status: 'sending' } }));

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    if (!results.some(r => r.status === 'fulfilled')) {
      markCommand(signed.id, { status: 'failed-to-send', error: '모든 릴레이에 발행 실패' });
      return null;
    }
  } finally {
    pool.destroy();
  }
  markCommand(signed.id, { status: 'pending' });

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      waiting.delete(signed.id);
      markCommand(signed.id, { status: 'timeout' });
      resolve(null);
    }, RESULT_TIMEOUT_MS);
    waiting.set(signed.id, result => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

/** 피드가 결과를 받았을 때 부른다 */
export function receiveResult(commandId: string, result: AdminCommandResult): void {
  markCommand(commandId, { status: 'done', result });
  waiting.get(commandId)?.(result);
  waiting.delete(commandId);
}

function markCommand(id: string, patch: Partial<import('./stores').CommandView>): void {
  commands.update(prev => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
}
