/**
 * LND 접속 (PLAN-DAEMON §4.5, §14 D3)
 *
 * 데몬은 운영 PC 안에서 LND REST를 직접 부른다 — 예전처럼 브라우저가 매크룬을 풀어 인터넷에 노출된
 * REST를 부르지 않는다. 자체 서명 TLS라 `fetch` 대신 `node:https`에 인증서를 넘긴다.
 *
 * 인터페이스(`LnNode`)로 둔 건 테스트 때문이다 — 가짜 노드로 HTLC 만기·결제 실패·조회 실패를 흉내 낸다.
 *
 * **모든 호출은 멱등하게 쓰일 수 있어야 한다**(효과 대기열이 재시도한다): 같은 해시로 인보이스를 또
 * 만들면 노드가 거절하므로 조회로 확인하고, 결제는 먼저 추적해 이미 나갔는지 본다.
 */
import { request } from 'node:https';
import { randomBytes } from 'node:crypto';

export type HoldState = 'open' | 'accepted' | 'settled' | 'cancelled';

export interface HoldLookup {
  state: HoldState;
  bolt11: string;
  /** accepted HTLC의 만기 블록 높이 — 에스크로가 **실제로** 죽는 때 (L-3) */
  htlcExpiryHeight?: number;
}

export type PayStatus = 'succeeded' | 'in-flight' | 'failed';

export interface PayResult {
  status: PayStatus;
  failureReason?: string;
}

export interface LnNode {
  blockHeight(): Promise<number>;
  addHoldInvoice(p: { paymentHash: string; amountSat: number; expirySec: number; cltvBlocks: number; memo: string }): Promise<{ bolt11: string }>;
  /** 모르는 인보이스면 null */
  lookupInvoice(paymentHash: string): Promise<HoldLookup | null>;
  settleInvoice(preimageHex: string): Promise<void>;
  cancelInvoice(paymentHash: string): Promise<void>;
  payInvoice(bolt11: string, feeLimitSat: number, timeoutSec: number): Promise<PayResult>;
  /** 결제를 시도한 적 없으면 null */
  trackPayment(paymentHash: string): Promise<PayStatus | null>;
  /** 후원자 노드까지 닿는가 — 막지는 않고 알려만 준다 */
  probe(bolt11: string): Promise<'reachable' | 'unreachable' | 'error'>;
}

export interface LndConfig {
  /** 예: https://host.docker.internal:8080 */
  url: string;
  cert: string | Buffer;
  macaroonHex: string;
}

const hexToB64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

class LndError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`LND ${status}: ${body.slice(0, 300)}`);
  }
}

export function createLndNode(config: LndConfig): LnNode {
  const base = new URL(config.url);

  /** JSON 한 번 받기. `firstLine`이면 NDJSON 스트림의 첫 줄만 읽고 끊는다 */
  function call<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number; firstLine?: boolean } = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = request({
        method,
        hostname: base.hostname,
        port: base.port || 443,
        path,
        ca: config.cert,
        headers: {
          'Grpc-Metadata-macaroon': config.macaroonHex,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: opts.timeoutMs ?? 30_000,
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
          if (opts.firstLine && text.includes('\n') && (res.statusCode ?? 0) < 300) {
            req.destroy();
            try { resolve(JSON.parse(text.slice(0, text.indexOf('\n'))) as T); } catch (e) { reject(e); }
          }
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 300) return reject(new LndError(status, text));
          // NDJSON 스트림이면 마지막 줄이 최종 결과
          const lines = text.trim().split('\n').filter(Boolean);
          try { resolve(JSON.parse(lines[lines.length - 1] ?? '{}') as T); } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => req.destroy(new Error(`LND ${path} 시간 초과`)));
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  const payStatus = (s: string | undefined): PayStatus =>
    s === 'SUCCEEDED' ? 'succeeded' : s === 'FAILED' ? 'failed' : 'in-flight';

  return {
    async blockHeight() {
      const info = await call<{ block_height: number }>('GET', '/v1/getinfo');
      return Number(info.block_height);
    },

    async addHoldInvoice({ paymentHash, amountSat, expirySec, cltvBlocks, memo }) {
      const r = await call<{ payment_request: string }>('POST', '/v2/invoices/hodl', {
        hash: hexToB64(paymentHash),
        value: String(amountSat),
        memo,
        expiry: String(Math.max(60, Math.floor(expirySec))),
        cltv_expiry: String(cltvBlocks),
      });
      return { bolt11: r.payment_request };
    },

    async lookupInvoice(paymentHash) {
      try {
        const r = await call<{
          state: string; payment_request: string;
          htlcs?: Array<{ expiry_height: number; state: string }>;
        }>('GET', `/v1/invoice/${paymentHash}`);
        const state: HoldState = r.state === 'ACCEPTED' ? 'accepted'
          : r.state === 'SETTLED' ? 'settled'
          : r.state === 'CANCELED' ? 'cancelled'
          : 'open';
        const held = (r.htlcs ?? []).filter(h => h.state === 'ACCEPTED' || h.state === 'SETTLED');
        const htlcExpiryHeight = held.length > 0 ? Math.min(...held.map(h => Number(h.expiry_height))) : undefined;
        return { state, bolt11: r.payment_request, ...(htlcExpiryHeight ? { htlcExpiryHeight } : {}) };
      } catch (e) {
        if (e instanceof LndError && (e.status === 404 || /unable to locate invoice|no invoice found/i.test(e.body))) {
          return null;
        }
        throw e;
      }
    },

    async settleInvoice(preimageHex) {
      await call('POST', '/v2/invoices/settle', { preimage: hexToB64(preimageHex) });
    },

    async cancelInvoice(paymentHash) {
      await call('POST', '/v2/invoices/cancel', { payment_hash: hexToB64(paymentHash) });
    },

    async payInvoice(bolt11, feeLimitSat, timeoutSec) {
      const r = await call<{ result?: { status: string; failure_reason?: string } }>('POST', '/v2/router/send', {
        payment_request: bolt11,
        timeout_seconds: timeoutSec,
        fee_limit_sat: String(feeLimitSat),
        no_inflight_updates: true,
      }, { timeoutMs: (timeoutSec + 30) * 1000 });
      const status = payStatus(r.result?.status);
      return status === 'failed' ? { status, failureReason: r.result?.failure_reason } : { status };
    },

    async trackPayment(paymentHash) {
      try {
        // 진행 중 상태까지 받아야 "지금" 상태를 안다 — 첫 줄만 읽고 끊는다.
        // ⚠️ 경로의 해시 인코딩(URL-safe base64)은 실노드로 확인해야 한다(드릴 항목)
        const r = await call<{ result?: { status: string } }>(
          'GET', `/v2/router/track/${hexToB64(paymentHash).replace(/\+/g, '-').replace(/\//g, '_')}?no_inflight_updates=false`,
          undefined, { firstLine: true, timeoutMs: 10_000 },
        );
        return payStatus(r.result?.status);
      } catch (e) {
        if (e instanceof LndError && /isn't initiated|not found/i.test(e.body)) return null;
        throw e;
      }
    },

    async probe(bolt11) {
      const d = await call<{
        destination: string; num_satoshis: string; cltv_expiry: string;
        route_hints?: Array<{ hop_hints: unknown[] }>;
      }>('GET', `/v1/payreq/${encodeURIComponent(bolt11)}`);
      const amountSat = Number(d.num_satoshis);
      // 없는 해시로 보낸다 — 프리이미지가 없으니 결제는 반드시 실패하고 돈은 안 움직인다
      const r = await call<{ result?: { status: string; failure_reason?: string } }>('POST', '/v2/router/send', {
        dest: hexToB64(d.destination),
        amt: String(amountSat),
        payment_hash: randomBytes(32).toString('base64'),
        timeout_seconds: 30,
        fee_limit_sat: String(Math.max(10, Math.ceil(amountSat * 0.01))),
        no_inflight_updates: true,
        max_parts: 1,
        final_cltv_delta: Number(d.cltv_expiry) || 40,
        ...(d.route_hints?.length ? { route_hints: d.route_hints } : {}),
      }, { timeoutMs: 60_000 });
      const reason = r.result?.failure_reason;
      if (reason === 'FAILURE_REASON_INCORRECT_PAYMENT_DETAILS') return 'reachable'; // 목적지까지 닿았다
      if (reason === 'FAILURE_REASON_NO_ROUTE' || reason === 'FAILURE_REASON_TIMEOUT'
        || reason === 'FAILURE_REASON_INSUFFICIENT_BALANCE') return 'unreachable';
      return 'error';
    },
  };
}

