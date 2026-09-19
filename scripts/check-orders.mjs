/**
 * 릴레이의 오더 이벤트를 그대로 떠서 본다 — `node scripts/check-orders.mjs`
 *
 * 화면이 이상할 때 "앱이 잘못 읽은 건가, 애초에 안 실린 건가"를 가르는 용도다.
 * 실제로 payout 태그가 통째로 빠진 걸 이걸로 확인했다(2026-09-19).
 *
 * kind 30402는 addressable이라 릴레이에 **주문당 최신 하나**만 남는다.
 * 즉 여기 안 보이는 값은 과거에 있었더라도 이미 덮어써진 것이고, 복구 못 한다.
 */
const APP = 'f1f3300a45164b562a82b86a9dcc0ee0e5f6c5b833a92e41cbf95b28b03ba848';

function query(url, filter, ms = 6000) {
  return new Promise(res => {
    const out = []; let ws;
    try { ws = new WebSocket(url); } catch { return res(out); }
    const done = () => { try { ws.close(); } catch {} res(out); };
    const t = setTimeout(done, ms);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'x', filter]));
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m[0] === 'EVENT') out.push(m[2]);
      if (m[0] === 'EOSE') { clearTimeout(t); done(); }
    };
    ws.onerror = () => { clearTimeout(t); done(); };
  });
}

// ① 앱의 릴레이 목록
const disco = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol'];
let relays = [];
for (const d of disco) {
  const evs = await query(d, { kinds: [10002], authors: [APP] });
  if (evs.length) {
    relays = evs[0].tags.filter(t => t[0] === 'r').map(t => t[1]);
    break;
  }
}
console.log('릴레이:', relays.join(', ') || '(못 찾음)');

// ② 오더 이벤트 수집
const seen = new Map();
for (const r of relays) {
  for (const ev of await query(r, { kinds: [30402], authors: [APP], '#t': ['sajwo-tracker'] })) {
    const d = ev.tags.find(t => t[0] === 'd')?.[1];
    if (!d) continue;
    const prev = seen.get(d);
    if (!prev || prev.created_at < ev.created_at) seen.set(d, ev);
  }
}

console.log('\n주문 %d건 (최신순)\n', seen.size);
const rows = [...seen.values()].sort((a, b) => b.created_at - a.created_at).slice(0, 8);
for (const ev of rows) {
  const g = n => ev.tags.find(t => t[0] === n)?.[1];
  console.log(
    '%s  %s  %s원  payout=%s  sponsor-invoice=%s  (%s)',
    g('d'), (g('state') ?? '?').padEnd(9), (g('price') ?? '?').padStart(7),
    g('payout') ?? '❌없음',
    g('sponsor-invoice') ? '있음' : '없음',
    new Date(ev.created_at * 1000).toLocaleString('ko-KR'),
  );
}
