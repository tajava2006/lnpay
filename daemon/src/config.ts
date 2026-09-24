/**
 * 데몬 설정 — 환경변수에서 읽는다.
 *
 * 태그·에포크를 shared 상수가 아니라 **여기서** 정한다(PLAN-DAEMON §10). shared 상수는 Vite 빌드
 * 모드를 따라 dev/prod가 갈리는데, 데몬에는 그 빌드 모드가 없다.
 *
 * 잘못된 값은 **부팅을 막는다.** 돈이 도는 프로세스가 반쯤 틀린 설정으로 떠서 조용히 도는 것보다
 * 안 뜨는 게 낫다.
 */
import { APP_PUBKEY } from '@sajwo-tracker/shared/core';

export type DaemonMode = 'prod' | 'dev';

export interface DaemonTags {
  /** 라이트닝 트랙 (`CLIENT_TAG`) */
  ln: string;
  /** 온체인 트랙 (`CLIENT_TAG_ONCHAIN`) */
  onchain: string;
  /** 운영자 명령·결과 (§5) */
  admin: string;
}

export interface DaemonConfig {
  mode: DaemonMode;
  tags: DaemonTags;
  /** SQLite·하트비트가 사는 곳 */
  dataDir: string;
  /** 시드 파일 (hex 64자) */
  seedFile: string;
  /** APP 키 파일 (nsec 또는 hex 64자) */
  appKeyFile: string;
  /** 이 키로 서명해야 한다 — 다르면 유저 앱이 우리 이벤트를 전부 버린다 */
  appPubkey: string;
  /** 명령을 받을 운영자 pubkey (hex) */
  operators: string[];
  /** 고정 릴레이. 비우면 APP의 kind 10002에서 찾는다 */
  relays: string[];
  /** 첫 부팅 때 여기서부터 받는다 (unix초). 비우면 부팅 시각 */
  epoch: number | undefined;
  /** 재구독할 때 커서에서 이만큼 되돌아가 다시 받는다 (중복은 id로 거른다) */
  lookbackSec: number;
  /** 구독을 주기적으로 새로 연다 — 조용히 죽은 연결을 탐지하려 애쓰지 않는다 */
  resubscribeSec: number;
  /** 틱 간격 */
  tickMs: number;
  /** 받은 이벤트를 이만큼 묵혔다가 created_at 순으로 처리한다 (릴레이마다 도착 순서가 다르다) */
  holdMs: number;
  /** LND REST (§14 D3). 호스트 LND를 boltz와 같은 방식으로 쓴다 */
  lnd: { url: string; certFile: string; macaroonFile: string };
  /** 없으면 웹 푸시를 보내지 않는다(거래는 그대로 돈다) */
  vapidKeyFile: string | undefined;
  /** VAPID `sub` — 푸시 서비스가 문제 생겼을 때 연락할 곳 */
  vapidSubject: string;
  /**
   * 온체인 트랙. 없으면 온체인 요청을 받지 않는다. **배포 설정이다** — 진행 중 거래가 있는데 네트워크를
   * 바꾸면 이미 낸 주소가 다른 체인의 것이 된다(그래서 `config.set`에 없다, §5.5).
   */
  onchain: { network: 'mainnet' | 'signet' | 'testnet'; apiUrl: string | undefined } | undefined;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function tagsFor(mode: DaemonMode): DaemonTags {
  const suffix = mode === 'dev' ? '-dev' : '';
  return {
    ln: `sajwo-tracker${suffix}`,
    onchain: `sajwo-tracker-onchain${suffix}`,
    admin: `sajwo-tracker-admin${suffix}`,
  };
}

export function loadConfig(env: Record<string, string | undefined>): DaemonConfig {
  const mode = env.LNPAY_MODE ?? 'prod';
  if (mode !== 'prod' && mode !== 'dev') throw new Error(`LNPAY_MODE는 prod|dev: ${mode}`);

  const operators = list(env.LNPAY_OPERATORS);
  if (operators.length === 0) throw new Error('LNPAY_OPERATORS가 비었다 — 명령을 받을 사람이 없다');
  for (const op of operators) {
    if (!HEX64.test(op)) throw new Error(`운영자 pubkey는 hex 64자: ${op}`);
  }

  const relays = list(env.LNPAY_RELAYS);
  for (const r of relays) {
    if (!/^wss?:\/\//.test(r)) throw new Error(`릴레이 주소가 아니다: ${r}`);
  }

  const appPubkey = (env.LNPAY_APP_PUBKEY ?? APP_PUBKEY).toLowerCase();
  if (!HEX64.test(appPubkey)) throw new Error(`LNPAY_APP_PUBKEY는 hex 64자: ${appPubkey}`);
  if (mode === 'prod' && appPubkey !== APP_PUBKEY) {
    throw new Error('prod에서 APP pubkey를 바꿀 수 없다 — 유저 앱은 APP_PUBKEY 상수만 믿는다');
  }

  return {
    mode,
    tags: tagsFor(mode),
    dataDir: required(env, 'LNPAY_DATA_DIR'),
    seedFile: required(env, 'LNPAY_SEED_FILE'),
    appKeyFile: required(env, 'LNPAY_APP_KEY_FILE'),
    appPubkey,
    operators,
    relays,
    epoch: optionalInt(env, 'LNPAY_EPOCH'),
    lookbackSec: optionalInt(env, 'LNPAY_LOOKBACK_SEC') ?? 6 * 60 * 60,
    resubscribeSec: optionalInt(env, 'LNPAY_RESUBSCRIBE_SEC') ?? 5 * 60,
    tickMs: optionalInt(env, 'LNPAY_TICK_MS') ?? 15_000,
    holdMs: optionalInt(env, 'LNPAY_HOLD_MS') ?? 1_500,
    lnd: {
      url: lndUrl(required(env, 'LNPAY_LND_URL')),
      certFile: required(env, 'LNPAY_LND_CERT_FILE'),
      macaroonFile: required(env, 'LNPAY_LND_MACAROON_FILE'),
    },
    vapidKeyFile: env.LNPAY_VAPID_KEY_FILE?.trim() || undefined,
    vapidSubject: env.LNPAY_VAPID_SUBJECT?.trim() || 'https://customer.hoppe-relay.it.com',
    onchain: onchainConfig(env),
  };
}

function onchainConfig(env: Record<string, string | undefined>): DaemonConfig['onchain'] {
  const network = env.LNPAY_ONCHAIN_NETWORK?.trim();
  if (!network) return undefined;
  if (network !== 'mainnet' && network !== 'signet' && network !== 'testnet') {
    throw new Error(`LNPAY_ONCHAIN_NETWORK는 mainnet|signet|testnet: ${network}`);
  }
  const apiUrl = env.LNPAY_ONCHAIN_API?.trim() || undefined;
  if (apiUrl && !/^https?:\/\//.test(apiUrl)) throw new Error(`LNPAY_ONCHAIN_API가 주소가 아니다: ${apiUrl}`);
  return { network, apiUrl };
}

function lndUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`LNPAY_LND_URL이 주소가 아니다: ${value}`);
  }
  // 매크룬이 헤더로 간다 — 평문으로 보내지 않는다
  if (url.protocol !== 'https:') throw new Error('LNPAY_LND_URL은 https여야 한다');
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key}가 필요하다`);
  return value;
}

function optionalInt(env: Record<string, string | undefined>, key: string): number | undefined {
  const value = env[key]?.trim();
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key}는 0 이상의 정수: ${value}`);
  return n;
}
