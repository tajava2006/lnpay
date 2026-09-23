/**
 * 온체인 로컬 전용 상태의 릴레이 백업 (PLAN-ONCHAIN-TRACK §9.1)
 *
 * 워처 소유권을 한 기기로 못박으면서(`lease.ts`) **기기 이전이 버튼 하나**가
 * 됐다. 그러면 "이 기기에만 있는 상태"가 전부 함정이 된다:
 *
 * | 잃으면 | 무슨 일이 나나 |
 * |---|---|
 * | 보증금 대기(`pending-deposit-store`) | 새 주인이 그 인보이스를 모른다 → 후원자가 결제해도 **아무도 감지하지 않는다**. 그 돈은 CLTV 만료까지 HTLC에 갇힌다 |
 * | 주문 메타(`escrow-meta-store`) | 릴리스 수수료를 못 구해 `anomaly`. 보증금 몰수에 필요한 프리이미지 키도 사라진다 |
 *
 * 둘 다 릴레이 이벤트로 재구성할 수 없다 — 어드민이 로컬에서 만든 값이다.
 * 그래서 NIP-78 + NIP-44(자기 자신에게 암호화)로 둔다. 오더·요청은 릴레이가
 * 이미 갖고 있고, 프리이미지와 어드민 키는 각자 자기 백업이 있다.
 *
 * ── 마지막 쓰기가 이긴다 — 그래도 되는 이유
 *
 * addressable event라 충돌 해결이 LWW다. 두 기기가 동시에 쓰면 한쪽이 통째로
 * 지워질 수 있는데, **소유권 때문에 한 번에 한 기기만 쓴다.** 리스가 이 백업의
 * 전제조건이다 — 순서가 반대면 안 된다.
 */
import { CLIENT_TAG_ONCHAIN } from '@sajwo-tracker/shared';
import { fetchAppState, publishAppState } from '../nostr/app-state-backup';
import {
  getOnchainDeposits, mergeOnchainDeposits, setOnchainDepositHook,
  type OnchainPendingDeposit,
} from './pending-deposit-store';
import {
  getAllEscrowMeta, mergeEscrowMetas, setEscrowMetaHook, type OnchainEscrowMeta,
} from './escrow-meta-store';

const DEPOSITS_TAG = `onchain-deposits:${CLIENT_TAG_ONCHAIN}`;
const META_TAG = `onchain-meta:${CLIENT_TAG_ONCHAIN}`;

/**
 * 변경 한 번에 발행 한 번이면 NIP-46 서명을 그만큼 부른다. 한 동작이 저장소를
 * 여러 번 건드리는 게 정상이라(인보이스 발행 → 메타 기록 → 삭제) 묶어서 보낸다.
 */
const DEBOUNCE_MS = 3_000;

type Timer = ReturnType<typeof setTimeout>;

function debounced(publish: () => Promise<void>): { fire: () => void; cancel: () => void } {
  let timer: Timer | null = null;
  return {
    fire: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void publish().catch(e => console.warn('[Onchain] 백업 발행 실패', e));
      }, DEBOUNCE_MS);
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

const depositBackup = debounced(() => publishAppState(DEPOSITS_TAG, getOnchainDeposits()));
const metaBackup = debounced(() => publishAppState(META_TAG, getAllEscrowMeta()));

/**
 * 백업본을 가져와 **빈 자리만** 채운다. 부팅 때 1회.
 *
 * 로컬이 이긴다 — 이 기기가 방금 만든 것이 옛 백업에 밀리면 안 된다
 * (라이트닝의 보증금 대기 복원과 같은 방향이다).
 */
export async function restoreOnchainLocalState(): Promise<void> {
  const deposits = await fetchAppState<unknown>(DEPOSITS_TAG);
  if (Array.isArray(deposits)) {
    const added = mergeOnchainDeposits(deposits as OnchainPendingDeposit[]);
    if (added > 0) console.log('[Onchain] 백업에서 보증금 대기 복원:', added);
  }

  const metas = await fetchAppState<unknown>(META_TAG);
  if (Array.isArray(metas)) {
    const touched = mergeEscrowMetas(metas as OnchainEscrowMeta[]);
    if (touched > 0) console.log('[Onchain] 백업에서 주문 메타 복원:', touched);
  }
}

/** 이후의 변경을 릴레이에 따라 쓰게 한다. **복원이 끝난 뒤** 부른다 */
export function startOnchainBackup(): void {
  setOnchainDepositHook(depositBackup.fire);
  setEscrowMetaHook(metaBackup.fire);
}

export function stopOnchainBackup(): void {
  setOnchainDepositHook(null);
  setEscrowMetaHook(null);
  depositBackup.cancel();
  metaBackup.cancel();
}
