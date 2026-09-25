/**
 * 시간 값 사이의 부등식 — `docs/LN-TRACK.md` §5 · `docs/ONCHAIN-TRACK.md` §6의 번호와 같다.
 *
 * 값 하나를 바꾸면 다른 값과의 관계가 조용히 깨진다. 예: 기한 상한을 늘리면 `cltvBlocksFor`가 보증금 CLTV를
 * 1500에서 **말없이 잘라** 판정 전에 보증금이 만료된다. 흐름 테스트는 그런 경계를 안 밟으므로 관계 자체를 여기서 잡는다.
 */
import { describe, expect, it } from 'vitest';
import { LN_ACTIVE_RETENTION_SEC, LN_MAX_DEADLINE_LEAD_SEC, LN_MIN_CLAIM_LEAD_SEC } from '@sajwo-tracker/shared/ln';
import {
  ACCOUNT_WINDOW_SEC, COSIGN_GRACE_WARNING_SEC, COSIGN_WINDOW_SEC, DEFAULT_TIMELOCK_BLOCKS, FUNDING_WINDOW_SEC,
  KRW_WINDOW_SEC, MAX_OPTION_WINDOW_SEC, MAX_ORDER_EXPIRY_SEC, MAX_TRADE_DURATION_SEC, ONCHAIN_EVENT_HORIZON_SEC,
  PRESIGN_WINDOW_SEC, PRICE_VALIDITY_MS, TIMELOCK_REMIT_THRESHOLD_BLOCKS,
} from '@sajwo-tracker/shared/onchain';
import {
  BLOCK_SEC, CATCHUP_WARMUP_SEC, CLTV_MAX_BLOCKS, CUSTOMER_DEPOSIT_MARGIN_SEC, DEADLINE_GRACE_SEC, ESCROW_END_BLOCKS,
  ESCROW_HOLD_MARGIN_SEC, ESCROW_PAY_LEAD_SEC, INVOICE_ESCROW_MIN_BLOCKS, MIN_ESCROW_PAY_WINDOW_SEC,
  SAFETY_SETTLE_BLOCKS, SPONSOR_DEPOSIT_MARGIN_SEC, SPONSOR_DEPOSIT_PAY_SEC, cltvBlocksFor,
} from '../ln/timing';
import { depositCltvBlocks } from '../onchain/deposit';
import { FEES_MAX_AGE_SEC, FEES_REFRESH_SEC } from '../onchain/fees';

/** LND `holdexpirydelta` 기본값 — 만기 이만큼 전에 노드가 홀드를 스스로 취소한다 */
const LND_HOLD_EXPIRY_DELTA = 12;

const blocks = (sec: number) => Math.ceil(sec / BLOCK_SEC);

describe('라이트닝 (LN-TRACK §5)', () => {
  it('① 가장 긴 보증금도 CLTV 상한 안이다 — 넘으면 cltvBlocksFor가 말없이 잘라 판정 전에 만료된다', () => {
    const longest = LN_MAX_DEADLINE_LEAD_SEC + Math.max(SPONSOR_DEPOSIT_MARGIN_SEC, CUSTOMER_DEPOSIT_MARGIN_SEC);
    expect(blocks(longest)).toBeLessThanOrEqual(CLTV_MAX_BLOCKS);
    expect(cltvBlocksFor(longest)).toBe(blocks(longest)); // 잘리지 않았다
  });

  it('② 가장 긴 에스크로도 CLTV 상한 안이다', () => {
    expect(blocks(LN_MAX_DEADLINE_LEAD_SEC + DEADLINE_GRACE_SEC + ESCROW_HOLD_MARGIN_SEC)).toBeLessThanOrEqual(CLTV_MAX_BLOCKS);
  });

  it('③ 보증금은 에스크로보다 오래 산다 — 에스크로가 끝난 뒤의 판정에서도 몰수할 수 있게', () => {
    const escrowTail = DEADLINE_GRACE_SEC + ESCROW_HOLD_MARGIN_SEC;
    expect(SPONSOR_DEPOSIT_MARGIN_SEC).toBeGreaterThan(escrowTail);
    expect(CUSTOMER_DEPOSIT_MARGIN_SEC).toBeGreaterThan(escrowTail);
  });

  it('④ 인보이스 수락 > 기한 전 닫기 > 선제 settle > 노드 자동 취소 (블록 문턱 순서)', () => {
    expect(INVOICE_ESCROW_MIN_BLOCKS).toBeGreaterThan(ESCROW_END_BLOCKS);
    expect(ESCROW_END_BLOCKS).toBeGreaterThan(SAFETY_SETTLE_BLOCKS);
    expect(SAFETY_SETTLE_BLOCKS).toBeGreaterThan(LND_HOLD_EXPIRY_DELTA);
  });

  it('⑤ 막바지 클레임도 승인될 틈이 있다', () => {
    expect(LN_MIN_CLAIM_LEAD_SEC).toBeGreaterThanOrEqual(
      SPONSOR_DEPOSIT_PAY_SEC + ESCROW_PAY_LEAD_SEC + MIN_ESCROW_PAY_WINDOW_SEC,
    );
  });

  it('⑥ 진행 중 오더는 에스크로가 끝날 때까지 릴레이에 남는다', () => {
    expect(LN_ACTIVE_RETENTION_SEC).toBeGreaterThan(DEADLINE_GRACE_SEC + ESCROW_HOLD_MARGIN_SEC);
  });

  it('⑦ 재시작 워밍업이 기한 유예보다 짧다', () => {
    expect(CATCHUP_WARMUP_SEC).toBeLessThan(DEADLINE_GRACE_SEC);
  });
});

describe('온체인 (ONCHAIN-TRACK §6)', () => {
  const now = 1_800_000_000;

  it('① 가장 긴 의뢰의 보증금도 CLTV 상한 안이다', () => {
    expect(depositCltvBlocks(now + MAX_ORDER_EXPIRY_SEC, now)).toBeLessThanOrEqual(CLTV_MAX_BLOCKS);
  });

  it('② 보증금은 남은 의뢰 수명 + 거래 최악 소요를 덮는다 (막바지 클레임 포함)', () => {
    for (const remaining of [60, 3600, MAX_ORDER_EXPIRY_SEC]) {
      expect(depositCltvBlocks(now + remaining, now) * BLOCK_SEC).toBeGreaterThanOrEqual(remaining + MAX_TRADE_DURATION_SEC);
    }
  });

  it('③ 옵션 창은 세 마감의 합이고, 최악 소요에 들어 있다', () => {
    expect(MAX_OPTION_WINDOW_SEC).toBe(PRESIGN_WINDOW_SEC + ACCOUNT_WINDOW_SEC + KRW_WINDOW_SEC);
    expect(MAX_TRADE_DURATION_SEC).toBeGreaterThanOrEqual(FUNDING_WINDOW_SEC + MAX_OPTION_WINDOW_SEC + COSIGN_WINDOW_SEC);
  });

  it('④ 확인 창 = 가격 유효창 (낡은 가격으로 체결되지 않는다)', () => {
    expect(COSIGN_WINDOW_SEC * 1000).toBe(PRICE_VALIDITY_MS);
  });

  it('⑤ 확인 마감 경고는 마감 전에 온다', () => {
    expect(COSIGN_GRACE_WARNING_SEC).toBeLessThan(COSIGN_WINDOW_SEC);
  });

  it('⑥ 원화가 흐를 때 타임락은 송금 차단 임계보다 한참 남아 있다', () => {
    expect(DEFAULT_TIMELOCK_BLOCKS).toBeGreaterThan(TIMELOCK_REMIT_THRESHOLD_BLOCKS);
    expect(DEFAULT_TIMELOCK_BLOCKS - blocks(MAX_OPTION_WINDOW_SEC)).toBeGreaterThan(TIMELOCK_REMIT_THRESHOLD_BLOCKS);
  });

  it('⑦ 진행 중 이벤트는 타임락보다 오래 릴레이에 남는다', () => {
    expect(ONCHAIN_EVENT_HORIZON_SEC).toBeGreaterThan(DEFAULT_TIMELOCK_BLOCKS * BLOCK_SEC);
  });

  it('⑧ 수수료 캐시는 갱신 한 번 실패를 버틴다', () => {
    expect(FEES_MAX_AGE_SEC).toBeGreaterThan(2 * FEES_REFRESH_SEC);
  });
});
