/**
 * 온체인 워처 소유권 (PLAN-ONCHAIN-TRACK §9.1)
 *
 * ── 왜 필요한가
 *
 * 어드민은 **설계상 여러 기기에서 돈다** — 키도 보증금 대기도 다기기를 전제로
 * 릴레이에 백업한다("PC에서 검증하고 모바일에서 중재"). 라이트닝에서는 그게
 * 안전하다. 두 기기가 같은 클레임을 각자 집어도 `claimed`를 두 번 쓸 뿐이고,
 * 마지막 쓰기가 이기고 끝난다 — **그 시점에 돈이 들어간 곳이 없다.**
 *
 * 온체인은 다르다. `listed → bonded`는 **에스크로 주소를 만든다.** 두 기기가
 * 서로 다른 후원자를 집으면 주소가 둘 생기고, kind 30402는 replaceable이라
 * 하나만 살아남는데 **고객은 먼저 본 주소로 펀딩할 수 있다.** 그러면 고객 돈이
 * 살아남은 주문에 적히지 않은 주소로 들어간다. 되찾는 건 원리적으로 가능하지만
 * (어드민 키는 orderId에서 결정적으로 파생되고 `{A,C}` 리프가 살아 있다)
 * 진 후원자의 x-only가 필요한데 그 기록은 지워진다 — 남는 건 8주 타임락뿐이고,
 * 그걸 눈과 손으로 할 UI는 없다.
 *
 * 그래서 **집행은 한 번에 한 기기만** 한다.
 *
 * ── 리스가 아니라 소유권이다 (하트비트 없음)
 *
 * 갱신을 주기적으로 발행하면 NIP-46 원격 서명이 30초마다 필요하다. 그럴 값어치가
 * 없다 — 소유권은 **사람이 옮긴다.** 온체인 스위치를 켜는 행위가 곧 주장이고,
 * 다른 기기에서 켜면 가져간다. 가진 기기는 매 틱 **읽기만** 해서 자기가 아직
 * 주인인지 확인한다(값싼 조회 하나).
 *
 * ── 두 개의 안전장치
 *
 * | 장치 | 막는 것 |
 * |---|---|
 * | 인수 지연(`HANDOVER_DELAY_SEC`) | 가져간 직후 **둘 다** 도는 구간. 옛 주인이 알아채는 데 최대 한 틱 걸린다 |
 * | 소유권 확인 만료(`OWNER_STALE_SEC`) | 옛 주인이 **릴레이를 못 읽는 사이** 남이 가져가는 분단. 못 읽으면 스스로 멈춘다 |
 *
 * 둘 다 **안전을 택하고 진행을 포기한다.** 워처가 멈춰서 늦어지는 판정은 전부
 * 늦어도 되는 것들이고(펀딩 감지·마감·컨펌), 릴레이를 못 읽으면 어차피 상태
 * 전이를 발행할 수도 없다.
 */
import { CLIENT_TAG_ONCHAIN } from '@sajwo-tracker/shared';
import { fetchAppStateResult, publishAppState } from '../nostr/app-state-backup';

const D_TAG = `onchain-watcher:${CLIENT_TAG_ONCHAIN}`;
const DEVICE_KEY = 'admin:device-id';

/** 가져간 뒤 이만큼 지나야 집행한다 — 옛 주인이 알아챌 시간(한 틱=30초)보다 길다 */
export const HANDOVER_DELAY_SEC = 90;

/** 소유권을 이만큼 확인 못 하면 멈춘다 */
export const OWNER_STALE_SEC = 300;

export interface WatcherLease {
  deviceId: string;
  /** 사람이 알아보라고 적는 이름. 판정에는 안 쓴다 */
  label: string;
  claimedAt: number;
}

export type LeaseHolder = 'mine' | 'other' | 'none';

/** 집행을 막는 이유. `null`이면 집행한다 */
export type LeaseBlock = 'other-device' | 'no-lease' | 'handover-wait' | 'stale';

export interface LeaseVerdict {
  holder: LeaseHolder;
  acting: boolean;
  why: LeaseBlock | null;
}

export interface LeaseSnapshot extends LeaseVerdict {
  lease: WatcherLease | null;
  myDeviceId: string;
  myLabel: string;
}

/**
 * 지금 이 기기가 집행해도 되는가. **순수 함수다.**
 *
 * 부수효과를 뺀 이유: 소유권 판정이 느슨해지면 두 기기가 같이 도는데, 그건
 * 로그에 아무 흔적도 안 남기고 **주소가 둘 생길 때에야** 드러난다.
 */
export function leaseVerdict(args: {
  lease: WatcherLease | null;
  myDeviceId: string;
  now: number;
  /** 마지막으로 소유권을 **성공적으로 읽은** 시각. 한 번도 못 읽었으면 null */
  lastReadAt: number | null;
}): LeaseVerdict {
  const { lease, myDeviceId, now, lastReadAt } = args;
  const holder: LeaseHolder = lease
    ? (lease.deviceId === myDeviceId ? 'mine' : 'other')
    : 'none';

  // 모르면 안 한다 — 옛 판정을 붙들고 도는 게 분단의 양쪽이 다 도는 경로다.
  if (lastReadAt === null || now - lastReadAt > OWNER_STALE_SEC) {
    return { holder, acting: false, why: 'stale' };
  }
  if (holder === 'none') return { holder, acting: false, why: 'no-lease' };
  if (holder === 'other') return { holder, acting: false, why: 'other-device' };
  if (lease && now < lease.claimedAt + HANDOVER_DELAY_SEC) {
    return { holder, acting: false, why: 'handover-wait' };
  }
  return { holder, acting: true, why: null };
}

export function leaseBlockText(snapshot: LeaseSnapshot): string {
  switch (snapshot.why) {
    case null: return '이 기기가 워처를 돌리고 있습니다';
    case 'other-device': return `다른 기기(${snapshot.lease?.label ?? '?'})가 돌리고 있습니다`;
    case 'no-lease': return '아직 아무 기기도 맡지 않았습니다';
    case 'handover-wait': return '소유권을 가져오는 중 — 곧 시작합니다';
    case 'stale': return '소유권을 확인할 수 없어 멈춰 있습니다 (릴레이 조회 실패)';
  }
}

// ─── 기기 신원 ───────────────────────────────────────────────

export function getDeviceId(): string {
  const saved = localStorage.getItem(DEVICE_KEY);
  if (saved) return saved;
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(DEVICE_KEY, id);
  return id;
}

/** 사람이 "폰이구나"를 알아볼 정도면 된다 */
export function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : '알 수 없는 기기';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : '브라우저';
  return `${os} · ${browser}`;
}

function isWatcherLease(value: unknown): value is WatcherLease {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.deviceId === 'string' && v.deviceId.length > 0
    && typeof v.label === 'string'
    && typeof v.claimedAt === 'number' && Number.isFinite(v.claimedAt);
}

// ─── 캐시 + 구독 ─────────────────────────────────────────────

const nowSec = (): number => Math.floor(Date.now() / 1000);

let lease: WatcherLease | null = null;
let lastReadAt: number | null = null;
let snapshot: LeaseSnapshot = buildSnapshot();
const listeners = new Set<() => void>();

function buildSnapshot(): LeaseSnapshot {
  const myDeviceId = getDeviceId();
  return {
    ...leaseVerdict({ lease, myDeviceId, now: nowSec(), lastReadAt }),
    lease,
    myDeviceId,
    myLabel: deviceLabel(),
  };
}

/**
 * 스냅샷은 **내용이 바뀔 때만** 새 객체가 된다.
 *
 * `useSyncExternalStore`가 매번 새 참조를 받으면 무한 렌더로 어드민 화면이
 * 통째로 안 뜬다 — 이미 한 번 겪었다(§11 P6).
 */
function recompute(): LeaseSnapshot {
  const next = buildSnapshot();
  const same = next.holder === snapshot.holder
    && next.acting === snapshot.acting
    && next.why === snapshot.why
    && next.lease?.deviceId === snapshot.lease?.deviceId
    && next.lease?.claimedAt === snapshot.lease?.claimedAt;
  if (same) return snapshot;

  snapshot = next;
  console.log('[Onchain] 워처 소유권:', leaseBlockText(next));
  listeners.forEach(fn => fn());
  return snapshot;
}

export function subscribeLease(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getLeaseSnapshot(): LeaseSnapshot {
  return snapshot;
}

/**
 * 지금 집행해도 되는가. **조회하지 않는다** — 마지막으로 읽어 둔 소유권으로
 * 판정한다(인수 대기는 시간이 지나면 저절로 풀리므로 시각만 다시 본다).
 */
export function canActOnchainNow(now = nowSec()): boolean {
  return leaseVerdict({ lease, myDeviceId: getDeviceId(), now, lastReadAt }).acting;
}

/**
 * 릴레이에서 소유권을 다시 읽는다. 못 읽으면 **읽은 시각을 갱신하지 않는다**
 * (그래야 `OWNER_STALE_SEC`가 흘러 스스로 멈춘다).
 *
 * ⚠️ **주장 시각은 뒤로 가지 않는다.** `pool.get`은 릴레이 여럿 중 **먼저 답한**
 * 하나를 주므로, 방금 발행한 최신본 대신 전파가 덜 된 릴레이의 옛 본을 받을 수
 * 있다. 그걸 그대로 믿으면 소유권이 앞뒤로 튄다 — 더 오래된 주장은 버린다.
 */
export async function refreshWatcherLease(): Promise<LeaseSnapshot> {
  const res = await fetchAppStateResult<unknown>(D_TAG);
  if (res.known) {
    const fetched = isWatcherLease(res.value) ? res.value : null;
    if (fetched && (!lease || fetched.claimedAt >= lease.claimedAt)) lease = fetched;
    lastReadAt = nowSec();
  }
  return recompute();
}

/**
 * 이 기기가 소유권을 가져온다.
 *
 * **발행 성공이 곧 주장이다.** 조회만으로 판정하면 릴레이가 죽었을 때
 * "아무도 없다"로 보여 남의 소유권을 조용히 빼앗는다. 발행이 실패하면 던진다.
 */
export async function claimWatcherLease(): Promise<LeaseSnapshot> {
  const mine: WatcherLease = {
    deviceId: getDeviceId(),
    label: deviceLabel(),
    claimedAt: nowSec(),
  };
  await publishAppState(D_TAG, mine);

  lease = mine;
  lastReadAt = nowSec();
  recompute();

  // 동시에 다른 기기가 주장했으면 여기서 갈린다. 지면 그 기기가 주인이고,
  // 이겨도 인수 지연이 남아 있어 바로 돌지는 않는다.
  return refreshWatcherLease();
}

/** @testing-only */
export function _resetForTesting(): void {
  lease = null;
  lastReadAt = null;
  listeners.clear();
  localStorage.removeItem(DEVICE_KEY);
  snapshot = buildSnapshot();
}
