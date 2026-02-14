/**
 * 테스트용 사줘 요청 이벤트 발행
 *
 * Usage:
 *   pnpm --filter @sajwo-tracker/admin publish                     # 랜덤 price, 랜덤 만료(1-24h)
 *   pnpm --filter @sajwo-tracker/admin publish -- --price 50000    # 5만원, 만료 랜덤
 *   pnpm --filter @sajwo-tracker/admin publish -- --exp 3600       # 랜덤 price, 1시간 뒤 만료
 *   pnpm --filter @sajwo-tracker/admin publish -- --price 30000 --exp 7200
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { SAJWO_REQUEST_KIND, CLIENT_TAG, APP_PUBKEY } from '@sajwo-tracker/shared';
import { TEST_SECRET_KEY, getRelays, randomInt } from './common';

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--');
  const priceIdx = args.indexOf('--price');
  const expIdx = args.indexOf('--exp');

  const price = priceIdx !== -1 ? Number(args[priceIdx + 1]) : randomInt(1_000, 100_000);
  const expSeconds = expIdx !== -1 ? Number(args[expIdx + 1]) : randomInt(3600, 86400);

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expSeconds;
  const orderId = String(randomInt(1_000_000_000, 9_999_999_999));

  const template = {
    kind: SAJWO_REQUEST_KIND,
    created_at: now,
    tags: [
      ['d', orderId],
      ['status', 'active'],
      ['price', String(price), 'KRW'],
      ['t', CLIENT_TAG],
      ['p', APP_PUBKEY],
      ['expiration', String(expiresAt)],
    ],
    content: '',
  };

  const signed = finalizeEvent(template, TEST_SECRET_KEY);

  console.log('--- Test Event ---');
  console.log('  orderId :', orderId);
  console.log('  price   :', price.toLocaleString(), 'KRW');
  console.log('  expires :', new Date(expiresAt * 1000).toLocaleString(), `(${expSeconds}s from now)`);
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

  console.log('\nDone. To mark as sold: pnpm --filter @sajwo-tracker/admin sold --', orderId);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
