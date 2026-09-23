/**
 * 오더 목록 — 트랙과 무관하게 "이 오더가 있나, 누가 당사자인가, 지금 몇 번째 버전인가"를 답한다.
 *
 * 명령의 버전 확인(DM-006)과 분쟁 채팅 중계(§5.4)가 이걸 본다. 라이트닝(P3)·온체인(P4) 모듈이 각자
 * 자기 테이블로 답하고, 데몬은 그 둘을 이어 붙인다.
 */
import type { OrderTarget, TrackName } from '@sajwo-tracker/shared/core';

export interface OrderParties {
  version: number;
  customer: string;
  sponsor?: string;
}

export interface OrderDirectory {
  lookup(track: TrackName, orderId: string): OrderParties | null;
}

/** 아직 트랙이 없을 때 — 아무 오더도 모른다 */
export const EMPTY_DIRECTORY: OrderDirectory = { lookup: () => null };

export function isTrack(value: unknown): value is TrackName {
  return value === 'ln' || value === 'onchain';
}

export type TargetCheck =
  | { ok: true; target: OrderTarget; parties: OrderParties }
  | { ok: false; error: 'bad-target' | 'unknown-order' | 'stale-version' };

/**
 * 오더를 바꾸는 명령의 대상 확인 (DM-006).
 *
 * `stale-version`은 **어드민 화면이 낡았다**는 뜻이다. 그 화면에서 누른 판정을 집행하면 이미 다른
 * 기기에서 끝낸 일을 또 하거나(몰수 두 번), 달라진 상황을 모른 채 결정하게 된다.
 */
export function checkTarget(directory: OrderDirectory, value: unknown): TargetCheck {
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'bad-target' };
  const v = value as Record<string, unknown>;
  if (!isTrack(v.track) || typeof v.orderId !== 'string' || v.orderId === '' || !Number.isInteger(v.version)) {
    return { ok: false, error: 'bad-target' };
  }
  const target: OrderTarget = { track: v.track, orderId: v.orderId, version: v.version as number };
  const parties = directory.lookup(target.track, target.orderId);
  if (!parties) return { ok: false, error: 'unknown-order' };
  if (parties.version !== target.version) return { ok: false, error: 'stale-version' };
  return { ok: true, target, parties };
}

/** 이 pubkey가 그 오더의 누구인가 */
export function roleIn(parties: OrderParties, pubkey: string): 'customer' | 'sponsor' | null {
  if (pubkey === parties.customer) return 'customer';
  if (parties.sponsor && pubkey === parties.sponsor) return 'sponsor';
  return null;
}
