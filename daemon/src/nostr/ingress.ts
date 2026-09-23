/**
 * 받기 (PLAN-DAEMON §4.3)
 *
 * kind 1111 중 APP 앞으로 온 것을 전부 `inbox`에 넣는다. 처리는 디스패처가 따로 한다 — 받는 순서와
 * 처리 순서를 떼어 놓아야 릴레이마다 다른 도착 순서가 판단을 흔들지 않는다.
 *
 * **구독을 주기적으로 새로 연다.** 오래 사는 구독은 조용히 죽는다(에러 없이 이벤트만 안 온다 — 형제
 * 프로젝트 cliprelay에서 길게 겪었다). 죽음을 탐지하려 애쓰는 대신 몇 분마다 커서에서 되돌아가 다시
 * 받는다. 겹치는 건 id로 거른다(DM-004) — 이 앱의 요청량이면 비용이 없다.
 */
import type { Event } from 'nostr-tools/core';
import { verifyEvent } from 'nostr-tools/pure';
import { SAJWO_REQUEST_EVENT_KIND } from '@sajwo-tracker/shared/core';
import type { Db } from '../db';
import type { Logger } from '../log';
import type { RelayTransport, Subscription } from './transport';

export interface IngressOptions {
  appPubkey: string;
  /** 첫 부팅 때만 쓴다 — 이후에는 DB에 박힌 값을 쓴다 */
  epoch: number;
  lookbackSec: number;
  resubscribeSec: number;
}

/** 미래 시각 이벤트로 커서를 밀어 올려 재구독이 진짜 이벤트를 건너뛰게 만드는 걸 막는다 */
const MAX_FUTURE_SKEW_SEC = 5 * 60;

const KV_EPOCH = 'ingress.epoch';
const KV_CURSOR = 'ingress.cursor';

export class Ingress {
  private sub: Subscription | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly epoch: number;

  constructor(
    private readonly db: Db,
    private readonly transport: RelayTransport,
    private readonly opts: IngressOptions,
    private readonly nowMs: () => number,
    private readonly log: Logger,
    /** 새 이벤트가 들어왔음을 알린다 — 틱을 기다리지 않고 처리하게 */
    private readonly onNew: () => void = () => {},
  ) {
    const saved = db.kvGet(KV_EPOCH);
    if (saved === undefined) {
      db.kvSet(KV_EPOCH, String(opts.epoch));
      this.epoch = opts.epoch;
    } else {
      this.epoch = Number(saved);
    }
  }

  start(): void {
    this.open();
    this.timer = setInterval(() => this.reopen(), this.opts.resubscribeSec * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sub?.close();
    this.sub = null;
  }

  /** 지금 커서로 구독을 다시 연다 */
  reopen(): void {
    this.sub?.close();
    this.open();
  }

  /** 다음 구독의 since — 커서에서 lookback만큼 되돌아간다. 에포크 앞으로는 안 간다 */
  since(): number {
    const cursor = Number(this.db.kvGet(KV_CURSOR) ?? this.epoch);
    return Math.max(this.epoch, cursor - this.opts.lookbackSec);
  }

  /**
   * 이벤트 하나를 받는다. 새로 들어갔으면 true.
   *
   * 서명은 여기서 다시 본다 — 실제 릴레이 풀은 이미 검증하지만, 전송 계층이 바뀌어도 위조가
   * 디스패처까지 가지 않게.
   */
  accept(event: Event): boolean {
    if (event.kind !== SAJWO_REQUEST_EVENT_KIND) return false;
    if (!event.tags.some(t => t[0] === 'p' && t[1] === this.opts.appPubkey)) return false;
    if (event.created_at < this.epoch) return false;
    if (!verifyEvent(event)) {
      this.log.warn('서명이 맞지 않는 이벤트를 버린다', { id: event.id });
      return false;
    }

    const nowSec = Math.floor(this.nowMs() / 1000);
    const inserted = this.db.tx(() => {
      const r = this.db.run(
        `INSERT OR IGNORE INTO inbox (id, pubkey, kind, created_at, raw, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
        event.id, event.pubkey, event.kind, event.created_at, JSON.stringify(event), this.nowMs(),
      );
      if (r.changes === 0) return false;
      if (event.created_at <= nowSec + MAX_FUTURE_SKEW_SEC) {
        const cursor = Number(this.db.kvGet(KV_CURSOR) ?? this.epoch);
        if (event.created_at > cursor) this.db.kvSet(KV_CURSOR, String(event.created_at));
      }
      return true;
    });

    if (inserted) this.onNew();
    return inserted;
  }

  private open(): void {
    const since = this.since();
    this.sub = this.transport.subscribe(
      { kinds: [SAJWO_REQUEST_EVENT_KIND], '#p': [this.opts.appPubkey], since },
      event => { this.accept(event); },
    );
    this.log.debug('구독 열림', { since });
  }
}
