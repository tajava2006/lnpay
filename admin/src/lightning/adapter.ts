import type { NodeInfo, DecodedInvoice, ProbeResult, HoldInvoiceResult } from './types';
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
   */
  createHoldInvoice(
    orderId: string,
    amountSat: number,
    expiry?: number,
  ): Promise<HoldInvoiceResult>;
}
