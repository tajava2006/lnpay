/**
 * 홀드 인보이스의 결제 해시 — 노드에서 바로 조회하라고(`lncli lookupinvoice <해시>`) 통째로 보여 주고 누르면 복사한다
 *
 * 줄이지 않는다 — 조회에는 64자가 다 필요하다. 폰에서도 쓰므로 길게 눌러 고르지 않아도 되게 한 번 누르면 복사.
 */
import { useState } from 'react';

export function PaymentHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드 권한이 없으면 글자를 골라 둔다(user-select: all) — 손으로 복사하면 된다
    }
  }

  return (
    <span style={styles.wrap}>
      <span style={styles.label}>결제 해시</span>
      <code style={styles.hash} title="누르면 복사" onClick={() => void copy()}>{hash}</code>
      {copied && <span style={styles.copied}>복사됨</span>}
    </span>
  );
}

const styles = {
  wrap: { display: 'inline-flex', flexWrap: 'wrap' as const, alignItems: 'baseline', gap: 6, minWidth: 0 },
  label: { fontSize: 11, color: '#6B7280' },
  hash: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: '#374151',
    wordBreak: 'break-all' as const, userSelect: 'all' as const, cursor: 'copy',
  },
  copied: { fontSize: 11, color: '#059669' },
};
