#!/usr/bin/env node
/**
 * 옛 어드민이 릴레이에 백업해 둔 VAPID 개인키를 되찾는다 (DAEMON-DEPLOY.md §1)
 *
 * 프론트 어드민은 VAPID 개인키를 kind 30078(`d = vapid:<CLIENT_TAG>`, APP이 서명, APP→APP NIP-44)으로
 * 백업했다. APP 키만 있으면 풀린다. 새로 만들면 `VAPID_PUBLIC_KEY`를 바꿔야 하고 **기존 구독이 전부
 * 무효**가 된다(유저가 알림을 다시 켜야 한다) — 되찾을 수 있으면 되찾는다.
 *
 *   node daemon/scripts/recover-vapid.mjs <APP 키 파일(nsec 또는 hex)> [dev] > lnpay-secrets/vapid.key
 *
 * 개인키를 stdout으로 낸다 — 터미널에 찍지 말고 바로 파일로 보낸다.
 */
import { readFileSync } from 'node:fs';
import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';
import { decrypt, getConversationKey } from 'nostr-tools/nip44';

const [file, mode] = process.argv.slice(2);
if (!file) {
  process.stderr.write('사용법: recover-vapid.mjs <APP 키 파일> [dev]\n');
  process.exit(2);
}
const raw = readFileSync(file, 'utf8').trim();
const sk = raw.startsWith('nsec1') ? decode(raw).data : Uint8Array.from(Buffer.from(raw, 'hex'));
const pk = getPublicKey(sk);
const dTag = `vapid:sajwo-tracker${mode === 'dev' ? '-dev' : ''}`;
const relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es'];

const pool = new SimplePool();
const events = await pool.querySync(relays, { kinds: [30078], authors: [pk], '#d': [dTag] }, { maxWait: 8000 });
pool.destroy();
const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
if (!latest) {
  process.stderr.write(`백업을 찾지 못했다 (${dTag}, author ${pk.slice(0, 8)}…) — 옛 어드민 기기 localStorage의 'vapid-private-key'를 보라\n`);
  process.exit(1);
}
const value = JSON.parse(decrypt(latest.content, getConversationKey(sk, pk)));
const key = typeof value === 'string' ? value : value?.privateKey ?? value?.d;
if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
  process.stderr.write('백업 모양이 예상과 다르다 — 내용을 직접 확인하라\n');
  process.exit(1);
}
process.stdout.write(key + '\n');
process.stderr.write(`되찾았다 (${new Date(latest.created_at * 1000).toISOString()} 백업)\n`);
