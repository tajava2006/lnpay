/**
 * 데몬 진입점 — 설정 → 비밀 → DB → 릴레이 → 런타임.
 *
 * 무엇 하나라도 틀리면 **뜨지 않는다**(설정·비밀 검증). docker의 재시작 정책이 계속 되살리려 하겠지만,
 * 반쯤 맞는 설정으로 조용히 도는 것보다 크래시 루프가 눈에 띈다.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAPID_PUBLIC_KEY, createPriceTracker, freshPrice } from '@sajwo-tracker/shared/core';
import { MempoolChainAdapter } from '@sajwo-tracker/shared/onchain';
import { loadConfig } from './config';
import { Db } from './db';
import { createLndNode } from './ln';
import { createLogger } from './log';
import { discoverAppRelays } from './nostr/discovery';
import { createPoolTransport } from './nostr/transport';
import { vapidKeyPairMatches } from './push/crypto';
import { Daemon } from './runtime';
import { readAppKeyFile, readMacaroonHex, readSeedFile, readVapidKeyFile } from './secrets';

async function main(): Promise<void> {
  const log = createLogger();
  const config = loadConfig(process.env);
  const seed = readSeedFile(config.seedFile);
  const appKey = readAppKeyFile(config.appKeyFile, config.appPubkey);

  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(join(config.dataDir, 'daemon.sqlite'));

  let relays = config.relays;
  if (relays.length === 0) {
    const found = await discoverAppRelays(appKey.pubkey);
    relays = found.relays;
    if (found.fallback) log.warn('APP의 kind 10002를 못 찾아 폴백 릴레이를 쓴다', { relays });
  }
  log.info('릴레이', { relays, mode: config.mode, onchain: config.onchain?.network ?? '꺼짐' });

  const node = createLndNode({
    url: config.lnd.url,
    cert: readFileSync(config.lnd.certFile),
    macaroonHex: readMacaroonHex(config.lnd.macaroonFile),
  });
  log.info('LND', { url: config.lnd.url, height: await node.blockHeight() });

  let push = null;
  if (config.vapidKeyFile) {
    const privateD = readVapidKeyFile(config.vapidKeyFile);
    // 짝이 아닌 키는 크롬에서만 조용히 실패한다(파폭은 통과) — 부팅에서 막는다
    if (!await vapidKeyPairMatches(VAPID_PUBLIC_KEY, privateD)) throw new Error('VAPID 개인키가 공개키의 짝이 아니다');
    push = { privateD, publicKey: VAPID_PUBLIC_KEY, subject: config.vapidSubject };
  } else {
    log.warn('VAPID 키가 없어 웹 푸시를 보내지 않는다');
  }

  // 시세는 거래소 웹소켓 셋의 중간값. 둘 이상이 1분 안에 값을 줘야 믿는다(금액이 정해지는 유일한 입력)
  const prices = createPriceTracker();
  prices.start();

  const transport = createPoolTransport(relays);
  const daemon = new Daemon({
    db,
    transport,
    appKey,
    seed,
    mode: config.mode,
    tags: config.tags,
    relays,
    operators: config.operators,
    epoch: config.epoch ?? Math.floor(Date.now() / 1000),
    lookbackSec: config.lookbackSec,
    resubscribeSec: config.resubscribeSec,
    tickMs: config.tickMs,
    holdMs: config.holdMs,
    nowMs: () => Date.now(),
    log,
    dataDir: config.dataDir,
    ln: { node, price: () => freshPrice(prices.getSnapshot(), Date.now()), push },
    ...(config.onchain ? {
      onchain: {
        network: config.onchain.network,
        // 공개 mempool.space는 우리 IP를 막은 적이 있다(2026-09-04) — 자체 인스턴스를 가리킬 수 있게
        chain: new MempoolChainAdapter({
          network: config.onchain.network, ...(config.onchain.apiUrl ? { baseUrl: config.onchain.apiUrl } : {}),
        }),
      },
    } : {}),
  });

  const shutdown = async (signal: string) => {
    log.info('종료 신호', { signal });
    await daemon.stop();
    prices.stop();
    transport.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  daemon.start();
}

main().catch(e => {
  process.stderr.write(`데몬 시작 실패: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
