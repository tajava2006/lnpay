/**
 * 내 키 백업·복원 (리뷰 #8)
 *
 * ── 왜 온체인 트랙에 필요한가
 *
 * 주문별 온체인 키는 이 앱의 nostr 키에서 **파생**된다. 그 nostr 키는 브라우저
 * 저장소에만 있다. 플랜은 "nostr 키에서 언제든 다시 파생하므로 잃을 수 없다"고 했지만,
 * **그 키를 옮기거나 되살릴 길이 없었다.** 저장소가 지워지면(브라우저 데이터 삭제, 홈
 * 화면에 안 올린 사이트를 iOS Safari가 7일 뒤 지우는 정책 등):
 *
 * - 진행 중인 에스크로의 환불·릴리스에 **서명할 수 없다**
 * - 타임락 회수도 못 한다 (그것도 내 키다)
 * - 옛 방식으로 환불받은 돈(주문별 키 주소)은 **영영 못 꺼낸다**
 *
 * 그래서 보여주고(백업), 넣을(복원) 수 있게 한다.
 *
 * ⚠️ 복원은 **지금 키를 덮는다.** 지금 키로 진행 중인 온체인 거래가 있으면 막는다 —
 * 덮으면 그 거래에 더 이상 서명할 수 없다.
 */
import { useState, useSyncExternalStore } from 'react';
import { decode, nsecEncode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';
import { STORAGE_KEYS, getSecretKey, storage } from '@sajwo-tracker/shared';
import { isOnchainTerminal } from '@sajwo-tracker/shared/onchain';
import { getOnchainOrdersSnapshot, myOnchainOrders, subscribeOnchainOrders } from '../store';

export function KeyBackup({ myPubkey }: { myPubkey: string | null }) {
  useSyncExternalStore(subscribeOnchainOrders, getOnchainOrdersSnapshot);
  const [open, setOpen] = useState(false);
  const [nsec, setNsec] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const live = myPubkey
    ? myOnchainOrders(myPubkey).filter(o => !isOnchainTerminal(o.state))
    : [];

  if (!open) {
    return (
      <button style={styles.toggle} onClick={() => setOpen(true)}>
        🔑 내 키 백업·복원 — 이 키가 없으면 환불·회수에 서명할 수 없습니다
      </button>
    );
  }

  async function reveal() {
    setNsec(nsecEncode(await getSecretKey(storage)));
  }

  async function restore() {
    setError(null);
    let sk: Uint8Array;
    try {
      const decoded = decode(input.trim());
      if (decoded.type !== 'nsec') throw new Error('nsec가 아닙니다');
      sk = decoded.data;
    } catch (e) {
      setError(`키를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const pubkey = getPublicKey(sk);
    if (pubkey === myPubkey) {
      setError('지금 쓰는 키와 같습니다');
      return;
    }
    if (live.length > 0) {
      setError(`지금 키로 진행 중인 온체인 거래가 ${live.length}건 있습니다. 끝난 뒤에 복원하세요 — 덮으면 그 거래에 서명할 수 없습니다.`);
      return;
    }
    if (!confirm('지금 키를 덮고 입력한 키로 바꿉니다. 지금 키를 백업해 두지 않았다면 그 키로 한 거래는 되찾을 수 없습니다. 진행할까요?')) {
      return;
    }
    await storage.set(STORAGE_KEYS.KEYPAIR, { secretKey: Array.from(sk), publicKey: pubkey });
    window.location.reload();
  }

  return (
    <div style={styles.box}>
      <p style={styles.title}>내 키 백업·복원</p>
      <p style={styles.warn}>
        온체인 에스크로의 환불·릴리스·타임락 회수는 전부 <strong>이 키</strong>로 서명합니다.
        키는 이 브라우저에만 있습니다 — <strong>안전한 곳에 적어 두세요.</strong> 남에게 보이면 그 사람이
        내 거래를 대신 서명할 수 있습니다.
      </p>

      {nsec ? (
        <div style={styles.row}>
          <code style={styles.key}>{nsec}</code>
          <button
            style={styles.btn}
            onClick={() => void navigator.clipboard.writeText(nsec).then(() => setCopied(true))}
          >
            {copied ? '복사됨' : '복사'}
          </button>
          <button style={styles.btn} onClick={() => setNsec(null)}>숨기기</button>
        </div>
      ) : (
        <button style={styles.btn} onClick={() => void reveal()}>키 보기</button>
      )}

      <p style={styles.sub}>다른 기기에서 쓰던 키로 바꾸기</p>
      <input
        style={styles.input}
        placeholder="nsec1…"
        value={input}
        onChange={e => setInput(e.target.value)}
      />
      <button style={styles.btn} onClick={() => void restore()} disabled={!input.trim()}>복원</button>
      {error && <p style={styles.error}>{error}</p>}

      <button style={styles.toggle} onClick={() => setOpen(false)}>닫기</button>
    </div>
  );
}

const styles = {
  toggle: { padding: '8px 10px', fontSize: 12, background: '#fff', color: '#6B7280', border: '1px dashed #D1D5DB', borderRadius: 8, cursor: 'pointer', textAlign: 'left' as const },
  box: { display: 'flex', flexDirection: 'column' as const, gap: 8, border: '1px solid #FDE68A', background: '#FFFBEB', borderRadius: 10, padding: 12 },
  title: { margin: 0, fontSize: 13, fontWeight: 600 as const, color: '#92400E' },
  warn: { margin: 0, fontSize: 12, color: '#92400E', lineHeight: 1.6 },
  sub: { margin: '6px 0 0', fontSize: 12, fontWeight: 600 as const, color: '#374151' },
  row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const },
  key: { fontSize: 11, wordBreak: 'break-all' as const, background: '#fff', border: '1px solid #FDE68A', borderRadius: 6, padding: '6px 8px', flex: 1 },
  input: { padding: '8px 10px', fontSize: 13, border: '1px solid #D1D5DB', borderRadius: 8 },
  btn: { padding: '6px 12px', fontSize: 12, background: '#fff', border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer', alignSelf: 'flex-start' as const },
  error: { margin: 0, fontSize: 12, color: '#DC2626' },
};
