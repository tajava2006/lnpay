import type { NodeInfo, DecodedInvoice, ProbeResult, HoldInvoiceResult, HoldInvoiceStatus, PaymentResult } from './types';
import type { RouteHintHop } from '../types';

/**
 * Lightning 노드 어댑터 인터페이스.
 *
 * 구현체(LND, CLN)의 REST API 차이를 추상화한다.
 */
export interface LightningAdapter {
  getInfo(): Promise<NodeInfo>;

  /** BOLT-11 인보이스를 디코딩한다. */
  decodeInvoice(bolt11: string): Promise<DecodedInvoice>;

  /**
   * 랜덤 payment hash로 프로빙하여 목적지까지의 인바운드 유동성을 검증한다.
   *
   * 내부에서 crypto.getRandomValues()로 32바이트 랜덤 해시를 생성하므로
   * 프리이미지가 존재하지 않으며, 결제는 반드시 실패하고 자금 이동은 없다.
   *
   * @param destination - 수신자 노드 pubkey (hex)
   * @param amountSat - 프로빙 금액 (sats)
   * @param finalCltvDelta - 최종 CLTV delta (디코딩된 인보이스에서 추출)
   * @param routeHints - bolt11 r-tag 라우트 힌트 (프라이빗 채널용)
   */
  probe(
    destination: string,
    amountSat: number,
    finalCltvDelta?: number,
    routeHints?: RouteHintHop[][],
  ): Promise<ProbeResult>;

  /**
   * Hold invoice를 생성한다.
   *
   * 내부에서 32바이트 랜덤 프리이미지를 생성하고 SHA-256 해시를 LN 노드에 전달한다.
   * 프리이미지는 escrow-store에 orderId 키로 자동 저장된다 (settle 시 필요).
   *
   * @param orderId - 오더 식별자 (escrow-store 키)
   * @param amountSat - 인보이스 금액 (sats)
   * @param expiry - 인보이스 만료 시간 (초, 기본 3600)
   * @param cltvExpiry - CLTV 타임아웃 (블록 수). HTLC가 유지되는 최대 기간.
   *   미지정 시 노드 기본값 사용. 에스크로 용도에서는 분쟁 판정 여유를 위해
   *   오더 만료보다 충분히 길게 설정해야 한다.
   */
  createHoldInvoice(
    orderId: string,
    amountSat: number,
    expiry?: number,
    cltvExpiry?: number,
  ): Promise<HoldInvoiceResult>;

  /**
   * Hold invoice의 현재 상태를 조회한다.
   *
   * @param paymentHash - payment hash (hex)
   */
  lookupHoldInvoice(paymentHash: string): Promise<HoldInvoiceStatus>;

  /**
   * Hold invoice를 정산(settle)한다.
   * 프리이미지를 LN 노드에 제출하여 HTLC를 확정하고 BTC를 수령한다.
   *
   * @param preimage - 프리이미지 (hex)
   */
  settleInvoice(preimage: string): Promise<void>;

  /**
   * Hold invoice를 취소(cancel)한다.
   * HTLC를 거부하여 Customer에게 BTC를 자동 환불한다.
   * 분쟁 판정에서 customer_wins 시 사용한다.
   *
   * @param paymentHash - payment hash (hex)
   */
  cancelInvoice(paymentHash: string): Promise<void>;

  /**
   * bolt11 인보이스에 결제를 전송한다.
   * Sponsor에게 BTC를 지급할 때 사용한다.
   *
   * @param bolt11 - BOLT-11 인코딩된 인보이스
   * @param feeLimitSat - 수수료 상한 (sats, 기본: 금액의 1% 또는 최소 10)
   */
  payInvoice(bolt11: string, feeLimitSat?: number): Promise<PaymentResult>;
}
