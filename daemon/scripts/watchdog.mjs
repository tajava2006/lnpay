#!/usr/bin/env node
/**
 * 바깥 감시 — 데몬이 멈췄는지 운영 PC **밖에서** 본다 (RISKS R-3, docs/DAEMON-DEPLOY.md §7)
 *
 * 데몬은 1분마다 운영자 상태(kind 33838)를 낸다. 그 시각이 오래되면 데몬·운영 PC·그 네트워크 중 하나가 멈춘
 * 것이다 — 그땐 데몬이 스스로 알릴 수 없으니 여기서 운영자에게 NIP-17 DM을 보낸다. 내용은 운영자에게 암호화돼
 * 있어 못 읽는다 — **시각만** 본다. (LND만 죽은 건 데몬이 직접 알린다 — 하트비트는 LND와 무관하게 돈다.)
 *
 * 클라우드 VPS에서 cron으로 5분마다 돈다:
 *   WATCHDOG_KEY_FILE=… WATCHDOG_OPERATORS=… node daemon/scripts/watchdog.mjs [--dry-run]
 *   --dry-run: 판단만 찍고 DM은 보내지 않는다(상태 파일도 안 건드린다)
 *
 * 환경변수
 *   WATCHDOG_KEY_FILE   DM을 보낼 감시용 키(nsec 또는 hex). **APP 키가 아니다** — 따로 만든다
 *   WATCHDOG_OPERATORS  운영자 pubkey(hex), 쉼표. 상태는 첫 운영자 앞으로 온 것을 본다
 *   WATCHDOG_STATE_FILE 마지막으로 알린 상태 (기본 ~/.lnpay-watchdog.json)
 *   WATCHDOG_STALE_SEC  이만큼 상태가 없으면 멈춘 것 (기본 600 — 데몬은 60초마다 낸다)
 *   WATCHDOG_MODE       prod | dev (기본 prod — 어드민 태그가 갈린다)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decode } from 'nostr-tools/nip19';
import { wrapEvent } from 'nostr-tools/nip17';

const APP = 'f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848';
const DISCOVERY = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol'];
const STATE_KIND = 33838; // ADMIN_STATE_KIND (shared/src/admin-protocol.ts)
/** 멈춘 동안 이만큼마다 다시 알린다 — DM 한 통을 놓치면 끝이 아니게 */
const REMIND_SEC = 6 * 60 * 60;

const dryRun = process.argv.includes('--dry-run');
const env = process.env;
const fail = msg => { process.stderr.write(`[감시] ${msg}\n`); process.exit(2); };

const operators = (env.WATCHDOG_OPERATORS ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (operators.length === 0 || !operators.every(p => /^[0-9a-f]{64}$/.test(p))) fail('WATCHDOG_OPERATORS(hex, 쉼표)가 필요하다');
const mode = env.WATCHDOG_MODE ?? 'prod';
if (mode !== 'prod' && mode !== 'dev') fail('WATCHDOG_MODE는 prod|dev');
const staleSec = Number(env.WATCHDOG_STALE_SEC ?? 600);
const stateFile = env.WATCHDOG_STATE_FILE ?? join(homedir(), '.lnpay-watchdog.json');

// 어드민 태그·상태 d 태그 — daemon/src/config.ts `tagsFor`, shared `adminStateDTag`와 같은 모양이어야 한다
const adminTag = mode === 'dev' ? 'sajwo-tracker-admin-dev' : 'sajwo-tracker-admin';
const stateD = `lnpay-admin:${adminTag}:state:${operators[0]}`;

/** 릴레이 하나에 묻는다 — EOSE까지 받았는지(답했는지)도 돌려준다. "모름"을 "없음"으로 뭉개지 않으려고 */
function query(url, filter, ms = 8000) {
  return new Promise(resolve => {
    const events = [];
    let ws;
    const done = answered => { try { ws?.close(); } catch { /* 이미 닫힘 */ } resolve({ events, answered }); };
    try { ws = new WebSocket(url); } catch { return resolve({ events, answered: false }); }
    const timer = setTimeout(() => done(false), ms);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'w', filter]));
    ws.onmessage = msg => {
      try {
        const m = JSON.parse(msg.data);
        if (m[0] === 'EVENT') events.push(m[2]);
        if (m[0] === 'EOSE') { clearTimeout(timer); done(true); }
      } catch { /* 모르는 메시지 */ }
    };
    ws.onerror = () => { clearTimeout(timer); done(false); };
  });
}

function publish(url, event, ms = 8000) {
  return new Promise(resolve => {
    let ws;
    const done = ok => { try { ws?.close(); } catch { /* 이미 닫힘 */ } resolve(ok); };
    try { ws = new WebSocket(url); } catch { return resolve(false); }
    const timer = setTimeout(() => done(false), ms);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = msg => {
      try {
        const m = JSON.parse(msg.data);
        if (m[0] === 'OK' && m[1] === event.id) { clearTimeout(timer); done(m[2] === true); }
      } catch { /* 모르는 메시지 */ }
    };
    ws.onerror = () => { clearTimeout(timer); done(false); };
  });
}

// ① APP의 릴레이 목록 — 데몬이 상태를 내고 운영자가 DM을 읽는 곳
let relays = [];
for (const d of DISCOVERY) {
  const { events } = await query(d, { kinds: [10002], authors: [APP] });
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (latest) {
    relays = latest.tags.filter(t => t[0] === 'r' && typeof t[1] === 'string' && (!t[2] || t[2] === 'read')).map(t => t[1]);
    break;
  }
}
if (relays.length === 0) {
  console.log('[감시] APP 릴레이 목록을 못 찾았다 — 판단 보류');
  process.exit(0);
}

// ② 최신 상태 시각
const results = await Promise.all(relays.map(r => query(r, { kinds: [STATE_KIND], authors: [APP], '#d': [stateD] })));
const answered = results.filter(r => r.answered).length;
if (answered === 0) {
  // 이쪽 네트워크 문제일 수 있다 — 데몬이 죽었다고 단정하지 않는다
  console.log('[감시] 릴레이가 하나도 답하지 않았다 — 판단 보류');
  process.exit(0);
}
const latest = Math.max(0, ...results.flatMap(r => r.events.map(e => e.created_at)));
const now = Math.floor(Date.now() / 1000);
const age = latest > 0 ? now - latest : null;
const stale = age === null || age > staleSec;

// ③ 알릴지 — 멈춤은 한 번(그 뒤 REMIND_SEC마다), 복구도 한 번
let prev = { down: false, alertedAt: 0 };
try { prev = { ...prev, ...JSON.parse(readFileSync(stateFile, 'utf8')) }; } catch { /* 처음 */ }
const ageText = age === null ? '상태를 찾지 못함' : `마지막 상태 ${Math.floor(age / 60)}분 전`;
let text = null;
if (stale && (!prev.down || now - prev.alertedAt >= REMIND_SEC)) {
  text = `[페어바이 감시] 데몬 응답 없음 — ${ageText}. 데몬·운영 PC·네트워크를 확인하세요.`;
} else if (!stale && prev.down) {
  text = `[페어바이 감시] 데몬이 다시 응답합니다 (${ageText}).`;
}

console.log(`[감시] 릴레이 ${answered}/${relays.length} 답함 · ${ageText} · ${stale ? '멈춤' : '정상'}${text ? ' → 알림' : ''}`);
if (!text || dryRun) {
  if (dryRun && text) console.log(`[감시] (dry-run) 보낼 DM: ${text}`);
  process.exit(0);
}

// ④ DM — 하나라도 받아야 상태를 적는다(못 보냈으면 다음 번에 다시)
const raw = readFileSync(env.WATCHDOG_KEY_FILE ?? fail('WATCHDOG_KEY_FILE이 필요하다'), 'utf8').trim();
const sk = raw.startsWith('nsec1') ? decode(raw).data : Uint8Array.from(Buffer.from(raw, 'hex'));
let delivered = 0;
for (const operator of operators) {
  const wrap = wrapEvent(sk, { publicKey: operator }, text);
  const oks = await Promise.all(relays.map(r => publish(r, wrap)));
  if (oks.some(Boolean)) delivered++;
}
if (delivered === 0) {
  process.stderr.write('[감시] DM을 어느 릴레이도 받지 않았다 — 다음 번에 다시\n');
  process.exit(1);
}
writeFileSync(stateFile, JSON.stringify({ down: stale, alertedAt: now }));
console.log(`[감시] DM 보냄 — 운영자 ${delivered}/${operators.length}`);
process.exit(0);
