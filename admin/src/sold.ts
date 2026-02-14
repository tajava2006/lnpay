/**
 * 테스트용 sold 이벤트 발행 (기존 orderId를 sold로 업데이트)
 *
 * Usage:
 *   pnpm --filter @sajwo-tracker/admin sold -- <orderId>
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { SAJWO_REQUEST_KIND, CLIENT_TAG, APP_PUBKEY } from '@sajwo-tracker/shared';
import { TEST_SECRET_KEY, getRelays } from './common';

async function main() {
  // pnpm이 -- 를 전달하므로 실제 인자만 추출
  const args = process.argv.slice(2).filter(a => a !== '--');
  const orderId = args[0];
  if (!orderId) {
    console.error('Usage: pnpm --filter @sajwo-tracker/admin sold -- <orderId>');
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);

  const template = {
    kind: SAJWO_REQUEST_KIND,
    created_at: now,
    tags: [
      ['d', orderId],
      ['status', 'sold'],
      ['price', '0', 'KRW'],
      ['t', CLIENT_TAG],
      ['p', APP_PUBKEY],
      ['expiration', String(now + 3600)],
    ],
    content: '',
  };

  const signed = finalizeEvent(template, TEST_SECRET_KEY);

  console.log('--- Sold Event ---');
  console.log('  orderId :', orderId);
  console.log('  eventId :', signed.id);
  console.log('');

  const relays = await getRelays();
  console.log('Publishing to:', relays);

  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        console.log('  OK:', r.value);
      } else {
        console.log('  FAIL:', String(r.reason));
      }
    }
  } finally {
    pool.destroy();
  }

  console.log('\nDone.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
