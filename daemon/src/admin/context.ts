/**
 * 어드민 채널 모듈들이 같이 쓰는 것
 */
import type { Db } from '../db';
import type { Effects } from '../effects';
import type { Logger } from '../log';
import type { DaemonMode, DaemonTags } from '../config';
import type { OrderDirectory } from '../orders/directory';
import type { AppKey } from '../secrets';

export interface AdminContext {
  db: Db;
  effects: Effects;
  appKey: AppKey;
  operators: readonly string[];
  tags: DaemonTags;
  mode: DaemonMode;
  relays: readonly string[];
  directory: OrderDirectory;
  version: string;
  startedAt: number;
  /** 받기 시작한 시각 (`resolveEpoch`) — 운영자 상태에 실어 어드민이 그 전 오더를 거른다 */
  epoch: number;
  /** 유저 앱 주소 — 공개 오더의 NIP-69 `source`. 없으면 싣지 않는다 */
  appUrl?: string;
  nowMs: () => number;
  log: Logger;
}

export const nowSec = (ctx: Pick<AdminContext, 'nowMs'>): number => Math.floor(ctx.nowMs() / 1000);
