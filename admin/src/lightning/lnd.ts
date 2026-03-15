import type { LightningAdapter } from './adapter';
import type { NodeInfo, DecodedInvoice, ProbeResult, HoldInvoiceResult, HoldInvoiceStatus, LnConnectionConfig, PaymentResult } from './types';
import type { RouteHintHop } from '../types';
import { savePreimage } from '../escrow-store';

// ─── 응답 타입 ───────────────────────────────────────────────

/** LND REST /v1/getinfo 응답 (사용하는 필드만) */
interface LndGetInfoResponse {
  identity_pubkey: string;
  alias: string;
  num_active_channels: number;
  num_peers: number;
  block_height: number;
  synced_to_chain: boolean;
  version: string;
}

/** LND REST /v1/balance/channels 응답 */
interface LndChannelBalanceResponse {
  balance: string;
}

/** LND REST /v1/balance/blockchain 응답 */
interface LndWalletBalanceResponse {
  confirmed_balance: string;
}

/** LND REST /v1/payreq 응답 */
interface LndDecodePayReqResponse {
  destination: string;
  payment_hash: string;
  num_satoshis: string;
  description: string;
  timestamp: string;
  expiry: string;
  cltv_expiry: string;
}

/**
 * LND /v2/router/send 스트리밍 응답의 Payment 객체.
 * failure_reason 값:
 *   0 = NONE, 1 = TIMEOUT, 2 = NO_ROUTE, 3 = ERROR,
 *   4 = INCORRECT_PAYMENT_DETAILS, 5 = INSUFFICIENT_BALANCE
 */
interface LndPayment {
  status: 'UNKNOWN' | 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED' | 'INITIATED';
  failure_reason:
    | 'FAILURE_REASON_NONE'
    | 'FAILURE_REASON_TIMEOUT'
    | 'FAILURE_REASON_NO_ROUTE'
    | 'FAILURE_REASON_ERROR'
    | 'FAILURE_REASON_INCORRECT_PAYMENT_DETAILS'
    | 'FAILURE_REASON_INSUFFICIENT_BALANCE';
}

// ─── 유틸리티 ─────────────────────────────────────────────────

/** hex 문자열 → base64 (LND REST는 bytes 필드에 base64를 사용) */
function hexToBase64(hex: string): string {
  let binary = '';
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
  }
  return btoa(binary);
}

/** Uint8Array → base64 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Uint8Array → hex 문자열 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * crypto.getRandomValues()로 32바이트 랜덤 payment hash를 생성한다.
 * 이 해시에 대응하는 프리이미지는 존재하지 않으므로 결제가 반드시 실패한다.
 */
function generateRandomPaymentHash(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

// ─── 어댑터 구현 ──────────────────────────────────────────────

export class LndAdapter implements LightningAdapter {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;

  constructor(config: LnConnectionConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authHeaders = { 'Grpc-Metadata-macaroon': config.credential };
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.authHeaders,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LND ${path} 실패: ${res.status} ${text}`);
    }
    return res.json();
  }

  async getInfo(): Promise<NodeInfo> {
    const [info, chanBal, walletBal] = await Promise.all([
      this.fetchJson<LndGetInfoResponse>('/v1/getinfo'),
      this.fetchJson<LndChannelBalanceResponse>('/v1/balance/channels'),
      this.fetchJson<LndWalletBalanceResponse>('/v1/balance/blockchain'),
    ]);

    return {
      pubkey: info.identity_pubkey,
      alias: info.alias,
      activeChannelsCount: info.num_active_channels,
      peersCount: info.num_peers,
      blockHeight: info.block_height,
      syncedToChain: info.synced_to_chain,
      version: info.version,
      channelBalanceSat: Number(chanBal.balance || '0'),
      onchainBalanceSat: Number(walletBal.confirmed_balance || '0'),
    };
  }

  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    const data = await this.fetchJson<LndDecodePayReqResponse>(
      `/v1/payreq/${encodeURIComponent(bolt11)}`,
    );

    return {
      destination: data.destination,
      amountSat: Number(data.num_satoshis),
      paymentHash: data.payment_hash,
      description: data.description,
      expiresAt: Number(data.timestamp) + Number(data.expiry),
      cltvExpiry: Number(data.cltv_expiry),
    };
  }

  async probe(
    destination: string,
    amountSat: number,
    finalCltvDelta = 40,
    routeHints?: RouteHintHop[][],
  ): Promise<ProbeResult> {
    // 랜덤 해시 생성 — 프리이미지가 존재하지 않으므로 결제가 반드시 실패
    const randomHash = generateRandomPaymentHash();

    const feeLimitSat = Math.max(Math.ceil(amountSat * 0.01), 10);

    // LND route_hints: 프라이빗 채널 뒤의 노드에 도달하기 위한 힌트
    const lndRouteHints = routeHints?.map(hops => ({
      hop_hints: hops.map(hop => ({
        node_id: hop.pubkey,
        chan_id: BigInt('0x' + hop.shortChannelId).toString(),
        fee_base_msat: hop.feeBaseMsat,
        fee_proportional_millionths: hop.feeProportionalMillionths,
        cltv_expiry_delta: hop.cltvExpiryDelta,
      })),
    }));

    const res = await fetch(`${this.baseUrl}/v2/router/send`, {
      method: 'POST',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dest: hexToBase64(destination),
        amt: String(amountSat),
        payment_hash: randomHash,
        timeout_seconds: 30,
        fee_limit_sat: String(feeLimitSat),
        no_inflight_updates: true,
        max_parts: 1,
        final_cltv_delta: finalCltvDelta,
        ...(lndRouteHints?.length ? { route_hints: lndRouteHints } : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: 'error', message: `프로브 요청 실패: ${res.status} ${text}` };
    }

    // /v2/router/send는 NDJSON 스트리밍 응답 — 마지막 줄이 최종 결과
    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];

    let payment: LndPayment;
    try {
      const parsed: { result: LndPayment } = JSON.parse(lastLine);
      payment = parsed.result;
    } catch {
      return { status: 'error', message: `응답 파싱 실패: ${lastLine}` };
    }

    // 결제가 성공했다면 심각한 버그 — 랜덤 해시로는 절대 발생하면 안 됨
    if (payment.status === 'SUCCEEDED') {
      throw new Error(
        'CRITICAL: 프로브가 성공(정산)했습니다. 이는 절대 발생해서는 안 되는 상황입니다. ' +
        '랜덤 payment hash가 실제 인보이스와 충돌했거나 심각한 버그가 있습니다.',
      );
    }

    switch (payment.failure_reason) {
      // 목적지까지 도달했으나 해시 불일치로 거부 → 유동성 존재 확인
      case 'FAILURE_REASON_INCORRECT_PAYMENT_DETAILS':
        return { status: 'reachable' };

      case 'FAILURE_REASON_NO_ROUTE':
        return { status: 'unreachable', reason: '경로를 찾을 수 없습니다' };

      case 'FAILURE_REASON_TIMEOUT':
        return { status: 'unreachable', reason: '프로브 시간 초과' };

      case 'FAILURE_REASON_INSUFFICIENT_BALANCE':
        return { status: 'unreachable', reason: '아웃바운드 유동성 부족' };

      default:
        return { status: 'error', message: `프로브 실패: ${payment.failure_reason}` };
    }
  }

  async createHoldInvoice(
    orderId: string,
    amountSat: number,
    expiry = 3600,
    cltvExpiry?: number,
  ): Promise<HoldInvoiceResult> {
    // 1. 32바이트 랜덤 프리이미지 생성
    const preimage = new Uint8Array(32);
    crypto.getRandomValues(preimage);

    // 2. SHA-256 해시 → payment hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', preimage);
    const paymentHash = new Uint8Array(hashBuffer);

    // 3. LND /v2/invoices/hodl 호출
    const res = await fetch(`${this.baseUrl}/v2/invoices/hodl`, {
      method: 'POST',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hash: bytesToBase64(paymentHash),
        value: String(amountSat),
        memo: `sajwo-tracker order ${orderId}`,
        expiry: String(expiry),
        ...(cltvExpiry != null ? { cltv_expiry: String(cltvExpiry) } : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LND /v2/invoices/hodl 실패: ${res.status} ${text}`);
    }

    const data: { payment_request: string } = await res.json();
    const paymentHashHex = bytesToHex(paymentHash);

    // 4. 프리이미지를 escrow-store에 저장 (settle 시 필요)
    savePreimage(orderId, bytesToHex(preimage), paymentHashHex);

    return { bolt11: data.payment_request, paymentHash: paymentHashHex };
  }

  async lookupHoldInvoice(paymentHash: string): Promise<HoldInvoiceStatus> {
    const data = await this.fetchJson<{ state: string }>(
      `/v1/invoice/${paymentHash}`,
    );

    switch (data.state) {
      case 'OPEN':      return 'open';
      case 'ACCEPTED':  return 'accepted';
      case 'SETTLED':   return 'settled';
      case 'CANCELED':  return 'cancelled';
      default:          throw new Error(`알 수 없는 인보이스 상태: ${data.state}`);
    }
  }

  async payInvoice(bolt11: string, feeLimitSat?: number): Promise<PaymentResult> {
    // bolt11을 디코딩하여 금액 기반 fee limit 계산
    const decoded = await this.decodeInvoice(bolt11);
    const limit = feeLimitSat ?? Math.max(Math.ceil(decoded.amountSat * 0.01), 10);

    const res = await fetch(`${this.baseUrl}/v2/router/send`, {
      method: 'POST',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_request: bolt11,
        timeout_seconds: 60,
        fee_limit_sat: String(limit),
        no_inflight_updates: true,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: 'failed', failureReason: `요청 실패: ${res.status} ${text}` };
    }

    // /v2/router/send는 NDJSON 스트리밍 응답 — 마지막 줄이 최종 결과
    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];

    let payment: LndPayment & { payment_preimage?: string };
    try {
      const parsed: { result: LndPayment & { payment_preimage?: string } } = JSON.parse(lastLine);
      payment = parsed.result;
    } catch {
      return { status: 'failed', failureReason: `응답 파싱 실패: ${lastLine}` };
    }

    if (payment.status === 'SUCCEEDED') {
      return {
        status: 'succeeded',
        preimage: payment.payment_preimage,
      };
    }

    return {
      status: 'failed',
      failureReason: payment.failure_reason,
    };
  }

  async settleInvoice(preimage: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v2/invoices/settle`, {
      method: 'POST',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preimage: hexToBase64(preimage),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LND /v2/invoices/settle 실패: ${res.status} ${text}`);
    }
  }

  async cancelInvoice(paymentHash: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v2/invoices/cancel`, {
      method: 'POST',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_hash: hexToBase64(paymentHash),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LND /v2/invoices/cancel 실패: ${res.status} ${text}`);
    }
  }
}
