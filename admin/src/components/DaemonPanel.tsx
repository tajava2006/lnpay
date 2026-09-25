/**
 * 데몬 상태 · 경보 · 설정
 *
 * 리모컨의 첫 화면. 데몬이 살아 있는지(하트비트), 사람이 봐야 할 경보가 있는지, 운영 설정이 무엇인지를
 * 보여주고 명령으로 바꾼다. 여기서는 아무것도 직접 집행하지 않는다.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  ADMIN_STATE_STALE_SEC, CLIENT_TAG_ADMIN, MAX_DEPOSIT_PCT,
  type AdminAlert, type AdminCommandResult, type DaemonSettings,
} from '@sajwo-tracker/shared';
import { ONCHAIN_WINDOWS, durationText, type OnchainWindows } from '@sajwo-tracker/shared/onchain';
import { sendCommand } from '../daemon/client';
import { daemonState } from '../daemon/stores';

function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function ago(sec: number): string {
  if (sec < 60) return `${Math.max(0, sec)}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

function resultText(result: AdminCommandResult | null): string {
  if (!result) return '데몬 응답 없음 — 집행됐는지 모릅니다. 상태를 보고 판단하세요';
  return result.ok ? '완료' : `거절: ${result.error}`;
}

export function DaemonPanel() {
  const view = useSyncExternalStore(daemonState.subscribe, daemonState.get);
  const now = useNow();
  const { state, eventAt } = view;

  const age = eventAt === null ? null : now - eventAt;
  const alive = age !== null && age <= ADMIN_STATE_STALE_SEC;

  return (
    <div style={styles.column}>
      <section style={styles.card}>
        <div style={styles.row}>
          <h2 style={styles.h2}>데몬</h2>
          <span style={{ ...styles.badge, ...(alive ? styles.ok : styles.bad) }}>
            {age === null ? '신호 대기 중' : alive ? `정상 · ${ago(age)}` : `응답 없음 · ${ago(age)}`}
          </span>
        </div>
        {state ? (
          <dl style={styles.dl}>
            <dt>버전</dt><dd>{state.daemonVersion} ({state.mode})</dd>
            <dt>시작</dt><dd>{new Date(state.startedAt * 1000).toLocaleString('ko-KR')}</dd>
            <dt>받기 시작</dt>
            <dd>
              {typeof state.epoch === 'number'
                ? `${new Date(state.epoch * 1000).toLocaleString('ko-KR')} (${state.epoch}) — 이 전의 오더는 보지 않는다. 유저 앱 VITE_NOSTR_SINCE도 이 값`
                : '모름 — 데몬이 옛 버전이다(다시 빌드). 그 전까지 오더 목록은 비어 있다'}
            </dd>
            <dt>온체인 창</dt>
            <dd><OnchainWindowsLine daemon={state.onchainWindows} /></dd>
            <dt>릴레이</dt><dd>{state.relays.join(', ')}</dd>
            <dt>효과 대기</dt>
            <dd>
              {state.effects.pending}건
              {state.effects.dead > 0 && <span style={styles.warnText}> · 포기 {state.effects.dead}건</span>}
            </dd>
          </dl>
        ) : (
          <div style={styles.note}>
            <p style={styles.note}>
              데몬이 이 운영자 키로 상태를 보내면 여기 뜹니다. 이 앱은 <code>{CLIENT_TAG_ADMIN}</code> 태그로
              데몬을 찾고 있습니다. 한참 안 뜨면:
            </p>
            <ol style={styles.hintList}>
              {/* 2026-09-24 실제로 이걸로 헤맸다 — pnpm dev는 -dev 태그라 prod 데몬과 서로 못 본다 */}
              <li>
                <b>데몬 모드와 이 빌드가 같은가</b> — <code>LNPAY_MODE=prod</code> 데몬이면 이 앱도 prod 빌드여야
                합니다. <code>pnpm dev:admin</code>은 <code>-dev</code> 태그라 prod 데몬과 서로 못 봅니다.
                로컬에서 prod로 보려면 <code>pnpm preview:admin</code>.
              </li>
              <li>데몬 설정 <code>LNPAY_OPERATORS</code>에 이 로그인 키(hex)가 들어 있는가.</li>
              <li>데몬 로그에 "다른 모드의 운영자 명령"이 찍히는가 (ping을 누른 뒤).</li>
            </ol>
          </div>
        )}
        <PingButton />
      </section>

      {state && <Alerts alerts={state.alerts} />}
      {state && <Settings settings={state.settings} />}
    </div>
  );
}

function PingButton() {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div style={styles.row}>
      <button
        style={styles.button}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          const started = Date.now();
          void sendCommand('ping')
            .then(r => setText(r?.ok ? `응답 ${((Date.now() - started) / 1000).toFixed(1)}초` : resultText(r)))
            .catch(e => setText(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? '보내는 중…' : 'ping'}
      </button>
      {text && <span style={styles.note}>{text}</span>}
    </div>
  );
}

function Alerts({ alerts }: { alerts: AdminAlert[] }) {
  const [status, setStatus] = useState<Record<number, string>>({});
  return (
    <section style={styles.card}>
      <h2 style={styles.h2}>경보 {alerts.length > 0 && <span style={styles.count}>{alerts.length}</span>}</h2>
      {alerts.length === 0 && <p style={styles.note}>사람이 볼 일이 없습니다.</p>}
      {alerts.map(a => (
        <div key={a.id} style={{ ...styles.alert, ...(a.level === 'anomaly' ? styles.anomaly : styles.warn) }}>
          <div>
            <strong>{a.level === 'anomaly' ? '이상' : '주의'}</strong>
            {a.orderId && <span style={styles.mono}> {a.track}:{a.orderId}</span>}
            <p style={styles.alertMessage}>{a.message}</p>
            <span style={styles.note}>{new Date(a.raisedAt * 1000).toLocaleString('ko-KR')}</span>
          </div>
          <div style={styles.alertActions}>
            <button
              style={styles.smallButton}
              onClick={() => {
                setStatus(s => ({ ...s, [a.id]: '보내는 중…' }));
                void sendCommand('alert.ack', { id: a.id }).then(r => setStatus(s => ({ ...s, [a.id]: resultText(r) })));
              }}
            >
              확인
            </button>
            {status[a.id] && <span style={styles.note}>{status[a.id]}</span>}
          </div>
        </div>
      ))}
    </section>
  );
}

function Settings({ settings }: { settings: DaemonSettings }) {
  const [draft, setDraft] = useState(settings);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 데몬이 다른 기기에서 바뀐 설정을 보내오면 따라간다 (편집 중이 아닐 때)
  useEffect(() => { if (!busy) setDraft(settings); }, [settings, busy]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const pct = (v: string) => Math.min(MAX_DEPOSIT_PCT, Math.max(0, Number(v) || 0));

  return (
    <section style={styles.card}>
      <h2 style={styles.h2}>운영 설정</h2>
      <label style={styles.field}>
        <input
          type="checkbox"
          checked={draft.ln.autoApprove}
          onChange={e => setDraft({ ...draft, ln: { ...draft.ln, autoApprove: e.target.checked } })}
        />
        라이트닝 클레임 자동 승인
      </label>
      <label style={styles.field}>
        고객 보증금
        <input
          style={styles.input}
          type="number" min={0} max={MAX_DEPOSIT_PCT} step={0.1}
          value={draft.ln.customerDepositPct}
          onChange={e => setDraft({ ...draft, ln: { ...draft.ln, customerDepositPct: pct(e.target.value) } })}
        />%
      </label>
      <label style={styles.field}>
        후원자 보증금
        <input
          style={styles.input}
          type="number" min={0} max={MAX_DEPOSIT_PCT} step={0.1}
          value={draft.ln.sponsorDepositPct}
          onChange={e => setDraft({ ...draft, ln: { ...draft.ln, sponsorDepositPct: pct(e.target.value) } })}
        />%
      </label>
      <label style={styles.field}>
        <input
          type="checkbox"
          checked={draft.onchain.acceptNewOrders}
          onChange={e => setDraft({ ...draft, onchain: { acceptNewOrders: e.target.checked } })}
        />
        온체인 새 의뢰 받기 (꺼도 진행 중 거래는 끝까지 간다)
      </label>
      <div style={styles.row}>
        <button
          style={styles.button}
          disabled={!dirty || busy}
          onClick={() => {
            setBusy(true);
            setStatus('보내는 중…');
            void sendCommand('config.set', { patch: draft })
              .then(r => setStatus(resultText(r)))
              .catch(e => setStatus(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
        >
          저장
        </button>
        {dirty && !busy && <button style={styles.smallButton} onClick={() => setDraft(settings)}>되돌리기</button>}
        {status && <span style={styles.note}>{status}</span>}
      </div>
    </section>
  );
}

const WINDOW_LABEL: Record<keyof OnchainWindows, string> = {
  funding: '입금', presign: '사전서명', account: '계좌', krw: '송금', cosign: '입금 확인',
};

function windowsText(w: OnchainWindows): string {
  return (Object.keys(WINDOW_LABEL) as Array<keyof OnchainWindows>)
    .map(k => `${WINDOW_LABEL[k]} ${durationText(w[k])}`).join(' · ');
}

/**
 * 데몬이 실제로 쓰는 창과 이 앱의 창 — 다르면 데몬 이미지가 옛 코드다(2026-09-25: 앱은 "입금 2시간"인데
 * 카운트다운은 6시간이었다. 마감은 데몬이 오더에 찍는다). 유저 앱도 같은 체크아웃에서 뜨므로 이 앱이 기준이다.
 */
function OnchainWindowsLine({ daemon }: { daemon: OnchainWindows | undefined }) {
  if (!daemon) return <>모름 — 데몬이 옛 버전이다(다시 빌드)</>;
  const same = (Object.keys(ONCHAIN_WINDOWS) as Array<keyof OnchainWindows>).every(k => daemon[k] === ONCHAIN_WINDOWS[k]);
  if (same) return <>{windowsText(daemon)}</>;
  return (
    <span style={{ color: '#B45309' }}>
      ⚠️ 데몬과 이 앱의 값이 다르다 — 데몬 이미지를 다시 빌드했는지 확인
      (<code>docker compose build lnpay-daemon</code> 뒤 컨테이너 재시작).
      <br />데몬: {windowsText(daemon)}
      <br />이 앱: {windowsText(ONCHAIN_WINDOWS)}
    </span>
  );
}

const styles = {
  column: { display: 'flex', flexDirection: 'column' as const, gap: 16 },
  card: { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column' as const, gap: 12 },
  row: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const },
  h2: { fontSize: 17, margin: 0, color: '#333', display: 'flex', alignItems: 'center', gap: 8 },
  badge: { padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600 as const },
  ok: { background: '#DCFCE7', color: '#166534' },
  bad: { background: '#FEE2E2', color: '#991B1B' },
  dl: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: 0, fontSize: 13, color: '#374151', wordBreak: 'break-all' as const },
  note: { fontSize: 12, color: '#6B7280', margin: 0 },
  hintList: { fontSize: 12, color: '#6B7280', margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.6 },
  warnText: { color: '#B45309' },
  button: { padding: '8px 16px', fontSize: 13, fontWeight: 600 as const, background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  smallButton: { padding: '6px 12px', fontSize: 12, background: '#E5E7EB', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer' },
  count: { background: '#EF4444', color: '#fff', borderRadius: 999, padding: '1px 8px', fontSize: 12 },
  alert: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: 12, borderRadius: 8, fontSize: 13 },
  anomaly: { background: '#FEF2F2', border: '1px solid #FECACA' },
  warn: { background: '#FFFBEB', border: '1px solid #FDE68A' },
  alertMessage: { margin: '4px 0', color: '#111827' },
  alertActions: { display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-end', gap: 4 },
  mono: { fontFamily: 'monospace', fontSize: 12, color: '#6B7280' },
  field: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#374151' },
  input: { width: 80, padding: '6px 8px', fontSize: 14, border: '1px solid #D1D5DB', borderRadius: 6 },
};
