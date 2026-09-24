/**
 * 데이터 디렉터리가 이 설정의 것인가 — 아니면 **일부러 안 뜬다** (2026-09-24)
 *
 * 장부 하나에는 모드 하나·온체인 네트워크 하나다. 섞이면 조용히 망가진다:
 *
 * - **모드**: prod 장부를 dev 데몬으로 띄우면 prod 오더를 `-dev` 태그로 다시 내고(유저 앱이 못 본다),
 *   dev에서 만든 오더를 나중에 prod가 이어받는다. signet 드릴 데몬(`LNPAY_MODE=dev`)은 반드시 자기
 *   장부를 쓴다 — 첫 부팅 때 모드를 박고, 다르면 거부한다.
 * - **온체인 네트워크**: 오더는 자기 네트워크(`order.network`)로 주소·서명을 만들지만 체인 조회는 데몬
 *   설정 하나로 한다. 진행 중 오더가 있는 채로 바꾸면 그 오더는 엉뚱한 체인을 조회하다 멈춘다(펀딩·환불·
 *   지급 전부). 온체인을 끈 채 진행 중 오더가 남아도 같다 — 감시가 안 돈다. 종결된 오더는 상관없다.
 */
import { isOnchainTerminal, type OnchainState } from '@sajwo-tracker/shared/onchain';
import type { Db } from './db';
import type { DaemonMode } from './config';

const KV_MODE = 'daemon.mode';

export function assertDataDirFits(db: Db, opts: { mode: DaemonMode; onchainNetwork: string | undefined }): void {
  const pinned = db.kvGet(KV_MODE);
  if (pinned === undefined) db.kvSet(KV_MODE, opts.mode);
  else if (pinned !== opts.mode) {
    throw new Error(
      `이 데이터 디렉터리는 LNPAY_MODE=${pinned} 데몬의 장부다 — ${opts.mode}로 띄우려면 다른 데이터 디렉터리를 써라`,
    );
  }

  const live = db.all<{ state: string; data: string }>('SELECT state, data FROM oc_orders')
    .filter(r => !isOnchainTerminal(r.state as OnchainState))
    .map(r => (JSON.parse(r.data) as { network?: string }).network ?? '?');
  if (live.length === 0) return;
  if (!opts.onchainNetwork) {
    throw new Error(`온체인을 껐는데 진행 중인 온체인 오더가 ${live.length}건 있다 — 끝날 때까지 LNPAY_ONCHAIN_NETWORK를 두어라`);
  }
  const other = live.filter(n => n !== opts.onchainNetwork);
  if (other.length > 0) {
    throw new Error(
      `진행 중인 온체인 오더 ${other.length}건이 ${[...new Set(other)].join(', ')} 오더다 — ` +
      `LNPAY_ONCHAIN_NETWORK=${opts.onchainNetwork}로 바꾸면 그 오더들이 멈춘다. 끝난 뒤에 바꿔라`,
    );
  }
}
