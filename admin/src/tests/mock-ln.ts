/**
 * 테스트용 MockLightningAdapter
 *
 * 실제 LN 노드 없이 공격 시나리오를 테스트할 수 있도록 LightningAdapter를 구현한다.
 * 어떤 LN 메서드가 호출됐는지 추적하고, 인보이스 상태를 직접 조작할 수 있다.
 */
import type { LightningAdapter } from '../lightning/adapter';
import type {
  NodeInfo,
  DecodedInvoice,
  ProbeResult,
  HoldInvoiceResult,
  HoldInvoiceStatus,
  PaymentResult,
} from '../lightning/types';
import type { RouteHintHop } from '@sajwo-tracker/shared';

export class MockLightningAdapter implements LightningAdapter {
  /** 각 메서드 호출 기록 */
  readonly calls = {
    createHoldInvoice: [] as Array<{ orderId: string; amountSat: number }>,
    settleInvoice: [] as string[],
    cancelInvoice: [] as string[],
    payInvoice: [] as string[],
    lookupHoldInvoice: [] as string[],
  };

  /** orderId → HoldInvoiceStatus 직접 제어 */
  invoiceStates: Record<string, HoldInvoiceStatus> = {};

  /** payInvoice 결과 제어 (기본 성공) */
  payInvoiceResult: PaymentResult = { status: 'succeeded' };

  reset(): void {
    this.calls.createHoldInvoice.length = 0;
    this.calls.settleInvoice.length = 0;
    this.calls.cancelInvoice.length = 0;
    this.calls.payInvoice.length = 0;
    this.calls.lookupHoldInvoice.length = 0;
    this.invoiceStates = {};
  }

  async getInfo(): Promise<NodeInfo> {
    return {
      pubkey: 'mock-node-pubkey',
      alias: 'mock-node',
      activeChannelsCount: 1,
      peersCount: 1,
      blockHeight: 800000,
      syncedToChain: true,
      version: '0.0.0-mock',
      channelBalanceSat: 10_000_000,
      onchainBalanceSat: 0,
    };
  }

  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    return {
      destination: 'mock-dest-pubkey',
      amountSat: 100_000,
      paymentHash: `hash-${bolt11.slice(0, 8)}`,
      description: 'mock invoice',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      cltvExpiry: 40,
    };
  }

  async probe(
    _destination: string,
    _amountSat: number,
  ): Promise<ProbeResult> {
    return { status: 'reachable' };
  }

  async createHoldInvoice(
    orderId: string,
    amountSat: number,
    _expiry?: number,
    _cltvExpiry?: number,
  ): Promise<HoldInvoiceResult> {
    this.calls.createHoldInvoice.push({ orderId, amountSat });
    const paymentHash = `mock-hash-${orderId}`;
    this.invoiceStates[paymentHash] = 'open';
    return {
      bolt11: `lnbc-mock-${orderId}`,
      paymentHash,
    };
  }

  async lookupHoldInvoice(paymentHash: string): Promise<HoldInvoiceStatus> {
    this.calls.lookupHoldInvoice.push(paymentHash);
    return this.invoiceStates[paymentHash] ?? 'open';
  }

  async settleInvoice(preimage: string): Promise<void> {
    this.calls.settleInvoice.push(preimage);
  }

  async cancelInvoice(paymentHash: string): Promise<void> {
    this.calls.cancelInvoice.push(paymentHash);
    this.invoiceStates[paymentHash] = 'cancelled';
  }

  async payInvoice(_bolt11: string): Promise<PaymentResult> {
    this.calls.payInvoice.push(_bolt11);
    return this.payInvoiceResult;
  }
}
