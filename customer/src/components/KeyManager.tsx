/**
 * 내 키 — 보기 · 다른 기기의 키 가져오기
 *
 * 계정이 없는 앱이라 키가 곧 나다. 키를 잃으면 진행 중인 온체인 거래의 환불·회수 서명을 할 수 없다. 키만
 * 있으면 다른 기기에서도 거래 기록이 릴레이에서 다시 불러와진다(`key-backup.ts`).
 */
import { useState } from 'react';
import { getPublicKey } from 'nostr-tools/pure';
import { activeTradeCount, myNsec, parseSecretKey, replaceKey } from '../key-backup';
import { useMyPubkey } from '../hooks';
import { ui } from '../ui';
import { Modal } from './Modal';

export function KeyManager({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="내 키" onClose={onClose}>
      <p style={ui.lead}>
        이 앱에는 계정이 없습니다. <b>이 키가 곧 나</b>입니다. 키만 있으면 다른 기기에서도 거래를 이어서 할 수
        있고, 키를 잃으면 진행 중인 온체인 거래의 환불·회수를 할 수 없습니다.
      </p>
      <ShowKey />
      <ImportKey />
    </Modal>
  );
}

function ShowKey() {
  const [nsec, setNsec] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!nsec) return;
    await navigator.clipboard.writeText(nsec);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={ui.panel}>
      <b>키 보관하기</b>
      <p style={ui.text}>
        비밀번호 관리자나 종이에 적어 두세요. 이 키를 가진 사람은 <b>나 대신 거래할 수 있습니다</b> — 아무에게도
        보여주지 마세요.
      </p>
      {nsec ? (
        <>
          <code style={styles.key}>{nsec}</code>
          <div style={styles.row}>
            <button onClick={() => void copy()} style={ui.primaryButton}>{copied ? '복사됨' : '복사'}</button>
            <button onClick={() => setNsec(null)} style={ui.ghostButton}>숨기기</button>
          </div>
        </>
      ) : (
        <button onClick={() => void myNsec().then(setNsec)} style={ui.primaryButton}>키 보기</button>
      )}
    </div>
  );
}

function ImportKey() {
  const myPubkey = useMyPubkey();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    const sk = parseSecretKey(input);
    if (!sk) {
      setError('키를 읽지 못했습니다. nsec1로 시작하는 키를 그대로 붙여 넣으세요.');
      return;
    }
    if (myPubkey && getPublicKey(sk) === myPubkey) {
      setError('이미 이 기기의 키입니다.');
      return;
    }
    const active = myPubkey ? activeTradeCount(myPubkey) : 0;
    const warning = [
      '이 기기의 지금 키와 기록을 지우고 가져온 키로 바꿉니다.',
      active > 0
        ? `⚠️ 지금 키로 진행 중인 거래가 ${active}건 있습니다. 지금 키를 보관해 두지 않았다면 그 거래를 더는 이어갈 수 없습니다.`
        : '',
      '가져온 키의 거래는 잠시 뒤 다시 불러옵니다. 알림은 새로 켜고, 쿠팡 유저스크립트를 쓰면 새로 설치하세요(옛 키가 들어 있습니다).',
      '예전 기기에서는 이 키를 지우세요 — 두 기기가 같은 거래를 만지면 계좌가 두 번 나갈 수 있습니다.',
    ].filter(Boolean).join('\n\n');
    if (!confirm(warning)) return;
    setBusy(true);
    await replaceKey(sk);
  }

  return (
    <div style={ui.panel}>
      <b>다른 기기의 키 가져오기</b>
      <p style={ui.text}>보관해 둔 키를 넣으면 그 키의 거래를 이 기기에서 이어갑니다.</p>
      <textarea
        style={styles.input}
        placeholder="nsec1…"
        value={input}
        onChange={e => setInput(e.target.value)}
        rows={2}
        autoComplete="off"
        spellCheck={false}
      />
      {error && <p style={ui.errorText}>{error}</p>}
      <button onClick={() => void submit()} style={ui.primaryButton} disabled={busy || input.trim() === ''}>
        {busy ? '바꾸는 중…' : '가져오기'}
      </button>
    </div>
  );
}

const styles = {
  key: {
    display: 'block', wordBreak: 'break-all' as const, fontSize: 12, padding: 10, marginBottom: 10,
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: 6,
  },
  row: { display: 'flex', gap: 8 },
  input: {
    width: '100%', boxSizing: 'border-box' as const, fontFamily: 'monospace', fontSize: 12, padding: 8,
    border: '1px solid #D1D5DB', borderRadius: 6, marginBottom: 10,
  },
};
