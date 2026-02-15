import type { NodeInfo, DecodedInvoice, ProbeResult } from './types';

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
   */
  probe(destination: string, amountSat: number, finalCltvDelta?: number): Promise<ProbeResult>;
}
