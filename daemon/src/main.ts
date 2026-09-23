/**
 * 데몬 진입점 — 설정 → 비밀 → DB → 릴레이 → 런타임.
 *
 * 무엇 하나라도 틀리면 **뜨지 않는다**(설정·비밀 검증). docker의 재시작 정책이 계속 되살리려 하겠지만,
 * 반쯤 맞는 설정으로 조용히 도는 것보다 크래시 루프가 눈에 띈다.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config';
import { Db } from './db';
import { createLogger } from './log';
import { discoverAppRelays } from './nostr/discovery';
import { createPoolTransport } from './nostr/transport';
import { Daemon } from './runtime';
import { readAppKeyFile, readSeedFile } from './secrets';

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
  log.info('릴레이', { relays, mode: config.mode });

  const transport = createPoolTransport(relays);
  const daemon = new Daemon({
    db,
    transport,
    appKey,
    seed,
    tags: config.tags,
    operators: config.operators,
    epoch: config.epoch ?? Math.floor(Date.now() / 1000),
    lookbackSec: config.lookbackSec,
    resubscribeSec: config.resubscribeSec,
    tickMs: config.tickMs,
    holdMs: config.holdMs,
    nowMs: () => Date.now(),
    log,
    dataDir: config.dataDir,
  });

  const shutdown = async (signal: string) => {
    log.info('종료 신호', { signal });
    await daemon.stop();
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
