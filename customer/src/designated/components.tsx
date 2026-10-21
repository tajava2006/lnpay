/**
 * 지정 거래 화면 부품 — 두 트랙이 같이 쓴다 (docs/LN-TRACK.md §7 · ONCHAIN-TRACK.md §10)
 *
 * - `DesignatedHeader` — 사주기 탭 맨 위. 지정 거래가 뭔지 한 줄 + [내 주소 보기]
 * - `MyAddressPanel` — 내 주소(npub) · QR · 확인 코드. **공유해도 되는 값**이라 🔑(비밀키) 화면과 분리한다
 * - `TradeModeToggle` — 의뢰 폼의 "공개 의뢰 / 지정 거래"
 * - `CounterpartyInput` — 상대 주소 붙여넣기·QR → 확인 코드 대조 ☑ → 위험 고지 ☑. 둘 다 체크해야 값을 낸다
 * - `DesignatedConsent` — 만들 때(고객): 확인 코드 대조 + 위험 고지
 * - `DesignatedAcceptConsent` — 수락할 때(후원자): 합의한 조건 확인 안내 + 위험 고지. 확인 코드는 묻지 않는다 — 지정
 *   의뢰는 누군가 내 주소를 지정해야만 뜨고 끼어들 자리가 없다(잘못 붙여넣기는 고객 쪽 대조가 막는다). 고객이 자기 코드를
 *   볼 화면도 마땅치 않아 실제로는 대조할 수 없었다(2026-10-19)
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { DESIGNATED_COPY, DESIGNATED_NOTICE, checkCode, npubOf } from '@sajwo-tracker/shared';
import { Modal } from '../components/Modal';
import { useMyPubkey } from '../hooks';
import { ui } from '../ui';
import { readCounterparty } from './view';

const QrScanner = lazy(() => import('../sponsor/components/QrScanner').then(m => ({ default: m.QrScanner })));

export type DesignatedTrack = 'ln' | 'onchain';

// ── 사주기 탭 머리 ──────────────────────────────────────────

export function DesignatedHeader({ track }: { track: DesignatedTrack }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={styles.header}>
      <div style={styles.headerText}>
        <b>지정 거래</b> — 이미 이야기가 된 상대와 <b>보증금 없이</b> 거래합니다. 내 주소를 상대에게 보내면, 상대가
        나를 지정해 {track === 'ln' ? '의뢰' : '팔기'}를 올리고 여기에 바로 뜹니다.
      </div>
      <button type="button" style={ui.ghostButton} onClick={() => setOpen(true)}>내 주소 보기</button>
      {open && (
        <Modal title="내 주소" onClose={() => setOpen(false)}>
          <MyAddressPanel />
        </Modal>
      )}
    </div>
  );
}

// ── 내 주소 ────────────────────────────────────────────────

export function MyAddressPanel() {
  const myPubkey = useMyPubkey();
  const [copied, setCopied] = useState(false);
  if (!myPubkey) return <p style={ui.text}>키를 준비하는 중…</p>;
  const npub = npubOf(myPubkey);

  async function copy() {
    try {
      await navigator.clipboard.writeText(npub);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      alert('복사하지 못했습니다. 아래 주소를 길게 눌러 복사하세요.');
    }
  }

  return (
    <div>
      <p style={ui.lead}>
        이 주소를 카톡 등으로 거래할 상대에게 보내세요. <b>공유해도 되는 값</b>입니다 — 이걸로는 나 대신 거래할 수
        없습니다. (🔑의 비밀키는 절대 주지 마세요.)
      </p>
      <div style={styles.qrWrap}>
        <QRCodeSVG value={`nostr:${npub}`} size={220} level="M" style={{ width: '100%', height: 'auto', maxWidth: 220 }} />
      </div>
      <code style={styles.npub}>{npub}</code>
      <button type="button" style={ui.primaryButton} onClick={() => void copy()}>{copied ? '복사됨' : '주소 복사'}</button>
      <p style={{ ...ui.text, marginTop: 16 }}>
        확인 코드 <b style={styles.code}>{checkCode(myPubkey)}</b>
        <br />상대가 내 주소를 넣으면 상대 화면에 이 코드가 뜹니다. 같은지 서로 확인하세요.
      </p>
    </div>
  );
}

// ── 거래 방식 ───────────────────────────────────────────────

export type TradeMode = 'public' | 'designated';

export function TradeModeToggle({ mode, onChange }: { mode: TradeMode; onChange: (mode: TradeMode) => void }) {
  const option = (value: TradeMode, title: string, sub: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      onClick={() => onChange(value)}
      style={mode === value ? { ...styles.mode, ...styles.modeOn } : styles.mode}
    >
      <b>{title}</b>
      <span style={styles.modeSub}>{sub}</span>
    </button>
  );
  return (
    <div style={styles.modes} role="group" aria-label="거래 방식">
      {option('public', '공개 의뢰', '오더북에 올림 · 보증금')}
      {option('designated', '지정 거래', '정한 상대만 · 보증금 없음')}
    </div>
  );
}

// ── 확인 코드 대조 + 위험 고지 ──────────────────────────────

export interface Consent {
  codeMatched: boolean;
  riskAccepted: boolean;
}

export const NO_CONSENT: Consent = { codeMatched: false, riskAccepted: false };

export const consentGiven = (c: Consent) => c.codeMatched && c.riskAccepted;

/** 상대 확인 코드를 보여주고 두 가지를 체크받는다. `who`는 상대를 부르는 말(상대 · 고객) */
export function DesignatedConsent({ track, code, who, value, onChange }: {
  track: DesignatedTrack;
  code: string;
  who: string;
  value: Consent;
  onChange: (next: Consent) => void;
}) {
  return (
    <div style={styles.consent}>
      <p style={styles.consentLine}>
        {who} 확인 코드 <b style={styles.code}>{code}</b>
      </p>
      <p style={styles.consentHint}>{DESIGNATED_NOTICE.checkCodeHint}</p>
      <label style={styles.check}>
        <input type="checkbox" checked={value.codeMatched} onChange={e => onChange({ ...value, codeMatched: e.target.checked })} />
        {who} 화면의 확인 코드와 같습니다
      </label>
      <RiskNotice track={track} checked={value.riskAccepted} onChange={riskAccepted => onChange({ ...value, riskAccepted })} />
    </div>
  );
}

/** 수락할 때(후원자) — 합의한 조건이 맞는지 보라는 안내 + 위험 고지 체크 하나 */
export function DesignatedAcceptConsent({ track, checked, onChange }: {
  track: DesignatedTrack;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div style={styles.consent}>
      <p style={styles.consentLine}>{DESIGNATED_COPY.acceptHint}</p>
      <RiskNotice track={track} checked={checked} onChange={onChange} />
    </div>
  );
}

/** 보증금이 없다는 고지 + "이해했다" 체크 — 만들 때·수락할 때 같은 말 */
function RiskNotice({ track, checked, onChange }: {
  track: DesignatedTrack;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <>
      <div style={styles.notice}>
        <b>{DESIGNATED_NOTICE.title}.</b> {DESIGNATED_NOTICE.common}{' '}
        {track === 'ln' ? DESIGNATED_NOTICE.ln : DESIGNATED_NOTICE.onchain}
      </div>
      <label style={styles.check}>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        위 내용을 이해했고, 믿을 수 있는 상대입니다
      </label>
    </>
  );
}

// ── 상대 주소 ───────────────────────────────────────────────

/**
 * 상대 주소 입력. **주소를 읽었고, 확인 코드 대조와 위험 고지를 둘 다 체크했을 때만** `onChange(pubkey)`, 아니면 null.
 * 주소가 바뀌면 체크는 풀린다 — 다른 주소에 대한 동의가 남지 않게.
 */
export function CounterpartyInput({ track, onChange }: {
  track: DesignatedTrack;
  onChange: (pubkey: string | null) => void;
}) {
  const myPubkey = useMyPubkey();
  const [text, setText] = useState('');
  const [consent, setConsent] = useState<Consent>(NO_CONSENT);
  const [scanning, setScanning] = useState(false);
  const read = readCounterparty(text, myPubkey);
  const ready = read.kind === 'ok' && consentGiven(consent) ? read.pubkey : null;

  useEffect(() => { onChange(ready); }, [ready, onChange]);

  function setAddress(next: string) {
    setText(next);
    setConsent(NO_CONSENT);
  }

  return (
    <div style={styles.counterparty}>
      <label style={styles.label}>
        상대 주소
        <div style={styles.inputRow}>
          <input
            style={styles.input}
            value={text}
            onChange={e => setAddress(e.target.value)}
            placeholder="npub1… (상대에게 받은 주소)"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" style={ui.ghostButton} onClick={() => setScanning(true)}>QR</button>
        </div>
      </label>
      {scanning && (
        <Suspense fallback={null}>
          <QrScanner onScan={data => { setAddress(data); setScanning(false); }} onClose={() => setScanning(false)} />
        </Suspense>
      )}
      {read.kind === 'invalid' && <p style={styles.error}>{read.message}</p>}
      {read.kind === 'self' && <p style={styles.error}>내 주소입니다. 상대의 주소를 넣으세요.</p>}
      {read.kind === 'ok' && (
        <DesignatedConsent track={track} code={read.code} who="상대" value={consent} onChange={setConsent} />
      )}
    </div>
  );
}

const styles = {
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' as const,
    padding: 12, marginBottom: 16, background: '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 8,
  },
  headerText: { flex: '1 1 220px', fontSize: 13, lineHeight: 1.6, color: '#4C1D95' },
  qrWrap: { display: 'flex', justifyContent: 'center', margin: '8px 0 12px' },
  npub: {
    display: 'block', wordBreak: 'break-all' as const, fontSize: 12, padding: 10, marginBottom: 10,
    background: '#F3F4F6', borderRadius: 6, color: '#111827',
  },
  code: { fontFamily: 'ui-monospace, monospace', fontSize: 15, letterSpacing: 0.5, color: '#111827' },
  modes: { display: 'flex', gap: 8, marginBottom: 12 },
  mode: {
    flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-start', gap: 2, padding: '10px 12px',
    background: '#fff', border: '1px solid #D1D5DB', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
    fontSize: 14, color: '#374151', textAlign: 'left' as const,
  },
  // `mode`와 같은 속성(border)으로 덮는다 — borderColor만 덮으면 끌 때 테두리가 글자색으로 남는다(App.tsx `tabOn`)
  modeOn: { border: '1px solid #4F46E5', background: '#EEF2FF', color: '#3730A3' },
  modeSub: { fontSize: 11, color: '#6B7280' },
  counterparty: { display: 'flex', flexDirection: 'column' as const, gap: 8, width: '100%' },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 6, fontSize: 13, fontWeight: 600 as const, color: '#374151' },
  inputRow: { display: 'flex', gap: 6 },
  input: { flex: 1, minWidth: 0, padding: '8px 12px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14 },
  error: { margin: 0, fontSize: 13, color: '#DC2626' },
  consent: {
    display: 'flex', flexDirection: 'column' as const, gap: 8, padding: 12,
    background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8,
  },
  consentLine: { margin: 0, fontSize: 13, color: '#374151' },
  consentHint: { margin: 0, fontSize: 12, lineHeight: 1.6, color: '#6B7280' },
  check: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, lineHeight: 1.5, color: '#111827', cursor: 'pointer' },
  notice: {
    padding: 10, background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 6,
    fontSize: 12, lineHeight: 1.6, color: '#9A3412',
  },
};
