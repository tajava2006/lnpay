import type { LightningAdapter } from './adapter';
import type { NodeInfo, DecodedInvoice, ProbeResult, HoldInvoiceResult, HoldInvoiceStatus, LnConnectionConfig, PaymentResult } from './types';
import type { RouteHintHop } from '../types';
import { savePreimage } from '../escrow-store';

// ─── 응답 타입 ───────────────────────────────────────────────

/** CLN clnrest POST /v1/getinfo 응답 (사용하는 필드만) */
interface ClnGetInfoResponse {
  id: string;
  alias: string;
  num_active_channels: number;
  num_peers: number;
  blockheight: number;
  version: string;
  warning_bitcoind_sync?: string;
}

/** CLN clnrest POST /v1/listfunds 응답 (사용하는 필드만) */
interface ClnListFundsResponse {
  channels: Array<{ our_amount_msat: number; state: string }>;
  outputs: Array<{ amount_msat: number; status: string }>;
}

/** CLN clnrest POST /v1/decode 응답 (bolt11) */
interface ClnDecodeResponse {
  payee: string;
  amount_msat?: number;
  payment_hash: string;
  description?: string;
  created_at: number;
  expiry: number;
  min_final_cltv_expiry: number;
}

/** CLN listholdinvoices 응답 (Boltz hold 플러그인) */
interface ClnListHoldInvoicesResponse {
  holdinvoices: Array<{
    state: 'unpaid' | 'accepted' | 'paid' | 'cancelled';
  }>;
}

/** CLN pay 응답 */
interface ClnPayResponse {
  status: string;
  payment_preimage?: string;
}

/** CLN clnrest POST /v1/getroute 응답 */
interface ClnGetRouteResponse {
  route: Array<{
    id: string;
    channel: string;
    direction: number;
    amount_msat: number;
    delay: number;
    style: string;
  }>;
}

/** CLN waitsendpay 에러 응답 */
interface ClnWaitSendPayError {
  code: number;
  message: string;
  data?: {
    failcode?: number;
    failcodename?: string;
    erring_node?: string;
  };
}

// ─── 유틸리티 ─────────────────────────────────────────────────

/** Uint8Array → hex 문자열 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * crypto.getRandomValues()로 32바이트 랜덤 payment hash를 생성한다.
 * 이 해시에 대응하는 프리이미지는 존재하지 않으므로 결제가 반드시 실패한다.
 */
function generateRandomPaymentHash(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

// ─── 어댑터 구현 ──────────────────────────────────────────────

export class ClnAdapter implements LightningAdapter {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;

  constructor(config: LnConnectionConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authHeaders = { Rune: config.credential };
  }

  private async postJson<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`CLN ${path} 실패: ${res.status} ${text}`);
    }
    return res.json();
  }

  async getInfo(): Promise<NodeInfo> {
    const [info, funds] = await Promise.all([
      this.postJson<ClnGetInfoResponse>('/v1/getinfo'),
      this.postJson<ClnListFundsResponse>('/v1/listfunds'),
    ]);

    const channelBalanceMsat = funds.channels
      .filter((ch) => ch.state === 'CHANNELD_NORMAL')
      .reduce((sum, ch) => sum + ch.our_amount_msat, 0);

    const onchainBalanceMsat = funds.outputs
      .filter((o) => o.status === 'confirmed')
      .reduce((sum, o) => sum + o.amount_msat, 0);

    return {
      pubkey: info.id,
      alias: info.alias,
      activeChannelsCount: info.num_active_channels,
      peersCount: info.num_peers,
      blockHeight: info.blockheight,
      syncedToChain: !info.warning_bitcoind_sync,
      version: info.version,
      channelBalanceSat: Math.floor(channelBalanceMsat / 1000),
      onchainBalanceSat: Math.floor(onchainBalanceMsat / 1000),
    };
  }

  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    const data = await this.postJson<ClnDecodeResponse>('/v1/decode', {
      string: bolt11,
    });

    return {
      destination: data.payee,
      amountSat: data.amount_msat ? Math.floor(data.amount_msat / 1000) : 0,
      paymentHash: data.payment_hash,
      description: data.description ?? '',
      expiresAt: data.created_at + data.expiry,
      cltvExpiry: data.min_final_cltv_expiry,
    };
  }

  async probe(
    destination: string,
    amountSat: number,
    finalCltvDelta = 9,
    _routeHints?: RouteHintHop[][],
  ): Promise<ProbeResult> {
    // 랜덤 해시 생성 — 프리이미지가 존재하지 않으므로 결제가 반드시 실패
    const randomHash = generateRandomPaymentHash();
    const amountMsat = amountSat * 1000;

    // 1. 경로 조회
    let route: ClnGetRouteResponse['route'];
    try {
      const routeRes = await this.postJson<ClnGetRouteResponse>('/v1/getroute', {
        id: destination,
        amount_msat: amountMsat,
        riskfactor: 10,
        cltv: finalCltvDelta,
      });
      route = routeRes.route;
    } catch {
      return { status: 'unreachable', reason: '경로를 찾을 수 없습니다' };
    }

    // 2. 랜덤 해시로 결제 시도 (반드시 실패)
    await this.postJson('/v1/sendpay', {
      route,
      payment_hash: randomHash,
      amount_msat: amountMsat,
    });

    // 3. 결과 대기
    try {
      const result = await this.postJson<{ status: string; payment_preimage?: string }>(
        '/v1/waitsendpay',
        { payment_hash: randomHash, timeout: 30 },
      );

      // 결제가 성공했다면 심각한 버그
      if (result.status === 'complete' && result.payment_preimage) {
        throw new Error(
          'CRITICAL: 프로브가 성공(정산)했습니다. 이는 절대 발생해서는 안 되는 상황입니다. ' +
          '랜덤 payment hash가 실제 인보이스와 충돌했거나 심각한 버그가 있습니다.',
        );
      }

      // 예상치 못한 성공 응답
      return { status: 'error', message: `예상치 못한 waitsendpay 응답: ${result.status}` };
    } catch (err: unknown) {
      // waitsendpay는 실패 시 HTTP 에러로 응답 — 에러 코드에서 결과 판별
      const error = parseClnError(err);
      if (!error) {
        return { status: 'error', message: `waitsendpay 에러 파싱 실패: ${String(err)}` };
      }

      // error code 203: 목적지에서 거부 (permanent failure at destination)
      // failcode 16399 = INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS → 유동성 존재 확인
      if (error.code === 203) {
        const failcode = error.data?.failcode;
        if (failcode === 16399) {
          return { status: 'reachable' };
        }
        return {
          status: 'unreachable',
          reason: error.data?.failcodename ?? `목적지 거부 (failcode: ${failcode})`,
        };
      }

      // error code 204: 경로 중간에서 실패
      if (error.code === 204) {
        return { status: 'unreachable', reason: '경로 유동성 부족' };
      }

      // error code 200: 타임아웃
      if (error.code === 200) {
        return { status: 'unreachable', reason: '프로브 시간 초과' };
      }

      return { status: 'error', message: error.message };
    }
  }
  async createHoldInvoice(
    orderId: string,
    amountSat: number,
    _expiry?: number,
    cltvExpiry?: number,
  ): Promise<HoldInvoiceResult> {
    // 1. 32바이트 랜덤 프리이미지 생성
    const preimage = new Uint8Array(32);
    crypto.getRandomValues(preimage);

    // 2. SHA-256 해시 → payment hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', preimage);
    const paymentHashHex = bytesToHex(new Uint8Array(hashBuffer));

    // 3. holdinvoice 호출 (Boltz hold 플러그인, 금액은 msat 단위)
    const data = await this.postJson<{ bolt11: string }>('/v1/holdinvoice', {
      payment_hash: paymentHashHex,
      amount: amountSat * 1000,
      ...(cltvExpiry != null ? { cltv_expiry: cltvExpiry } : {}),
    });

    // 4. 프리이미지를 escrow-store에 저장 (settle 시 필요)
    savePreimage(orderId, bytesToHex(preimage), paymentHashHex);

    return { bolt11: data.bolt11, paymentHash: paymentHashHex };
  }

  async lookupHoldInvoice(paymentHash: string): Promise<HoldInvoiceStatus> {
    const data = await this.postJson<ClnListHoldInvoicesResponse>(
      '/v1/listholdinvoices',
      { payment_hash: paymentHash },
    );

    if (data.holdinvoices.length === 0) {
      throw new Error(`hold invoice를 찾을 수 없습니다: ${paymentHash}`);
    }

    const state = data.holdinvoices[0].state;
    switch (state) {
      case 'unpaid':    return 'open';
      case 'accepted':  return 'accepted';
      case 'paid':      return 'settled';
      case 'cancelled': return 'cancelled';
      default:          throw new Error(`알 수 없는 hold invoice 상태: ${state}`);
    }
  }

  async settleInvoice(preimage: string): Promise<void> {
    await this.postJson('/v1/settleholdinvoice', { preimage });
  }

  async cancelInvoice(paymentHash: string): Promise<void> {
    await this.postJson('/v1/cancelholdinvoice', { payment_hash: paymentHash });
  }

  async payInvoice(bolt11: string, feeLimitSat?: number): Promise<PaymentResult> {
    const decoded = await this.decodeInvoice(bolt11);
    const limit = feeLimitSat ?? Math.max(Math.ceil(decoded.amountSat * 0.01), 10);

    try {
      const data = await this.postJson<ClnPayResponse>('/v1/pay', {
        bolt11,
        maxfee: limit * 1000,
      });

      if (data.status === 'complete') {
        return { status: 'succeeded', preimage: data.payment_preimage };
      }
      return { status: 'failed', failureReason: `결제 상태: ${data.status}` };
    } catch (err: unknown) {
      return {
        status: 'failed',
        failureReason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * CLN HTTP 에러 응답에서 에러 코드/메시지를 추출한다.
 * waitsendpay 실패 시 HTTP 500과 함께 JSON 에러 바디가 온다.
 */
function parseClnError(err: unknown): ClnWaitSendPayError | null {
  if (err instanceof Error) {
    // postJson이 throw하는 에러 메시지에서 JSON 부분 추출 시도
    const match = err.message.match(/\{.*\}/s);
    if (match) {
      try {
        return JSON.parse(match[0]) as ClnWaitSendPayError;
      } catch {
        return null;
      }
    }
  }
  return null;
}
