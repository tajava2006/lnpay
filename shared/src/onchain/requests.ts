/**
 * 온체인 트랙 요청 이벤트 (kind 1111)
 *
 * 라이트닝과 같은 kind·같은 전송 배관을 쓰고 **action 값만 다르다.**
 * 새 전송 계층을 만들 이유가 없다 — 계좌정보가 이미 그 길로 다닌다.
 *
 * ── 무엇을 태그에 싣고 무엇을 암호문에 싣나
 *
 * kind 1111은 **공개 이벤트**다. 그래서:
 *
 * | 실리는 곳 | 값 | 왜 |
 * |---|---|---|
 * | 태그 (공개) | `amount-sat`, `*-xonly`, `purpose`, `stage` | 일회성 파생 키·금액. 오더에 이미 공개돼 있다 |
 * | 암호문 (NIP-44) | **PSBT**, 후원자의 받을 주소·feerate | PSBT 안에 **후원자의 실제 지갑 주소**가 들어 있다 |
 *
 * 받을 주소가 공개되면 제3자가 그 지갑을 따라갈 수 있다 — 파생 키와 달리
 * 그건 일회성이 아니다.
 *
 * ⚠️ **파서는 암호문을 풀지 않는다.** `raw`로 넘기고 복호화는 핸들러 몫이다
 * (라이트닝의 `account-info`와 같은 규약).
 */
import type { RequestBase } from '../types';

/**
 * 고객 → 어드민: 온체인 의뢰 등록.
 *
 * 암호문에 `{ refundAddress }`가 들어 있다 — 환불·고객승·구조 tx가 가는 **고객 자기
 * 지갑 주소**다. 전에는 주문별 키로 만든 단일키 주소로 보냈는데, 그 주소는
 * **이 앱만 쓸 수 있고** 꺼낼 화면도 없었다. 브라우저 저장소가 지워지면 그대로 소실이다.
 */
export interface OnchainOrderRequestMsg extends RequestBase {
  action: 'onchain-order-request';
  amountSat: number;
  /** 최저 수용 KRW (선택). 없으면 시장가 */
  reserveKrw?: number;
  /** 고객의 주문별 x-only 키 */
  customerXonly: string;
}

/**
 * 후원자 → 어드민: 클레임.
 *
 * **이것만으로는 아무도 예약되지 않는다** — 어드민이 보증금 인보이스를
 * 발행하고, **먼저 결제한 쪽**이 `bonded`로 간다. 여러 명이 동시에 보내도 된다.
 *
 * 암호문에 `{ payoutAddress, feerateSatPerVb }`가 들어 있다 — 받을 주소와
 * 희망 수수료율을 **이때 미리** 낸다. 사전서명은 펀딩 txid에 커밋하므로
 * 펀딩 이후에만 가능하지만, 주소·feerate는 미리 받아둘 수 있다.
 */
export interface OnchainClaimMsg extends RequestBase {
  action: 'onchain-claim';
  sponsorXonly: string;
}

/** 후원자 → 어드민: 사전서명된 릴리스 PSBT (암호문) */
export interface OnchainPresigMsg extends RequestBase {
  action: 'onchain-presig';
}

/**
 * 유저 → 어드민: 최종 서명 (암호문).
 *
 * **릴리스 전용이 아니다**. `{A,C}`를 쓰는 종결은 전부 고객 서명이
 * 필요하다 — 환불과 고객승 분쟁까지. 즉 **어드민 혼자서는 환불도 못 한다.**
 *
 * ⚠️ **고객 전용도 아니다.** `sponsor_win`은 `{A,S}`라 **후원자**가 서명한다(`dispute-sponsor`).
 * 누가 보냈는지는 핸들러가 오더의 pubkey와 대조해 확인한다.
 */
export interface OnchainCosignMsg extends RequestBase {
  action: 'onchain-cosign';
  /**
   * `rescue`는 FSM 밖이다 — 약정과 다른 모양으로 들어온 자금을 고객에게 돌려준다.
   * 소모하는 UTXO가 PSBT 입력에 들어 있어 핸들러가 그걸로 대기 중인 구조를 찾는다.
   */
  purpose: 'release' | 'refund' | 'dispute-customer' | 'dispute-sponsor' | 'rescue';
}

/**
 * 양쪽 → 어드민: 분쟁 제기.
 *
 * `stage: 'account-unusable'`는 **상태 전이가 아니라 증거**다. 그걸로 `disputed`에
 * 보내면 원화 마감 시계가 멈추고 **무한 옵션이 열린다**.
 * 마감은 그대로 흐르고, 그 주장은 **보증금을 몰수할지 환불할지만** 가른다.
 */
export interface OnchainDisputeMsg extends RequestBase {
  action: 'onchain-dispute';
  stage?: 'account-unusable' | 'remitted';
}

/**
 * 어드민 → 유저: 요청을 처리할 수 없다.
 *
 * 최소 거래액 미달, 의뢰 만료 초과, 수수료·시세 조회 실패 같은 것들이다.
 * **유저에게 도달해야 한다** — 안 그러면 "등록했는데 아무 일도 안 일어난다".
 */
export interface OnchainRejectedMsg extends RequestBase {
  action: 'onchain-rejected';
  reason: string;
}

export type OnchainRequest =
  | OnchainOrderRequestMsg
  | OnchainClaimMsg
  | OnchainPresigMsg
  | OnchainCosignMsg
  | OnchainDisputeMsg
  | OnchainRejectedMsg;

/** 클레임 암호문의 모양 — 후원자 앱이 만들고 어드민이 푼다 */
export interface OnchainClaimPayload {
  /** 후원자가 비트코인을 받을 주소 */
  payoutAddress: string;
  /** 릴리스 tx에 쓸 희망 feerate (sat/vB). **후원자가 정한다** */
  feerateSatPerVb: number;
}

/** 의뢰 등록 암호문의 모양 */
export interface OnchainOrderRequestPayload {
  /** 환불금을 받을 고객 지갑 주소 */
  refundAddress: string;
}

export function isOnchainOrderRequestPayload(value: unknown): value is OnchainOrderRequestPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.refundAddress === 'string' && v.refundAddress.trim().length > 0;
}

/** 사전서명·최종서명 암호문의 모양 */
export interface OnchainPsbtPayload {
  psbt: string;
}

export function isOnchainClaimPayload(value: unknown): value is OnchainClaimPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.payoutAddress === 'string' && v.payoutAddress.length > 0
    && typeof v.feerateSatPerVb === 'number' && Number.isFinite(v.feerateSatPerVb)
    && v.feerateSatPerVb > 0;
}

export function isOnchainPsbtPayload(value: unknown): value is OnchainPsbtPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.psbt === 'string' && v.psbt.length > 0;
}
