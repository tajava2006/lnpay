/**
 * 온체인 진행도 — 지금 누구 차례인지, 마감이 언제인지
 *
 * 단계표는 `shared/onchain/progress.ts`가 진실이다. 여기서는 그리기만 한다.
 */
import type { OnchainOrder, OnchainRole } from '@sajwo-tracker/shared/onchain';
import { resolveOnchainProgress } from '@sajwo-tracker/shared/onchain';

interface Props {
  order: OnchainOrder;
  role: OnchainRole;
  accountInfoSent?: boolean;
}

/**
 * 단계표 문구의 `**…**`를 굵게 — 단계표가 강조를 이 표기로 적는다. 예전엔 글자 그대로 그려 별표가 화면에 보였다(2026-10-22).
 * 짝이 안 맞으면 마지막 조각이 굵어질 뿐 글자는 다 보인다.
 */
function Rich({ text }: { text: string }) {
  return <>{text.split('**').map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))}</>;
}

export function OnchainProgressBar({ order, role, accountInfoSent }: Props) {
  const progress = resolveOnchainProgress(role, order.state, {
    accountInfoSent,
    settlementKind: order.settlementKind,
    designated: Boolean(order.designatedSponsor),
  });

  return (
    <div style={styles.wrap}>
      <div style={styles.track}>
        {progress.steps.map(step => (
          <div
            key={step.state}
            style={{
              ...styles.dot,
              background: step.status === 'done' ? '#059669'
                : step.status === 'current' ? '#2563EB' : '#E5E7EB',
            }}
            title={step.title}
          />
        ))}
      </div>

      {progress.terminal ? (
        <div style={styles.terminal}>
          <strong>{progress.terminal.label}</strong>
          <p style={styles.desc}><Rich text={progress.terminal.description} /></p>
        </div>
      ) : progress.refunding ? (
        <div style={styles.refunding}>
          <strong>{progress.refunding.label}</strong>
          <p style={styles.desc}><Rich text={progress.refunding.description} /></p>
        </div>
      ) : progress.disputed ? (
        <div style={styles.dispute}>
          <strong>분쟁 중</strong>
          <p style={styles.desc}>운영자가 증거를 보고 판정합니다. 채팅에 자료를 올려주세요.</p>
        </div>
      ) : (
        <div>
          <p style={styles.title}>
            {progress.steps[progress.currentIndex]?.title ?? ''}
            {progress.steps[progress.currentIndex]?.isMyTurn && (
              <span style={styles.myTurn}>내 차례</span>
            )}
          </p>
          <ul style={styles.actions}>
            {progress.steps[progress.currentIndex]?.actions.map((a, i) => (
              <li key={i} style={styles.action}><Rich text={a.text} /></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  track: { display: 'flex', gap: 4 },
  dot: { flex: 1, height: 4, borderRadius: 2 },
  title: { margin: 0, fontSize: 14, fontWeight: 600 as const, color: '#111827' },
  myTurn: {
    marginLeft: 6, fontSize: 11, fontWeight: 600 as const,
    background: '#DBEAFE', color: '#2563EB', padding: '2px 6px', borderRadius: 4,
  },
  actions: { margin: '6px 0 0', paddingLeft: 16, display: 'flex', flexDirection: 'column' as const, gap: 4 },
  action: { fontSize: 13, color: '#4B5563', lineHeight: 1.5 },
  terminal: { background: '#F3F4F6', borderRadius: 8, padding: '10px 12px' },
  dispute: { background: '#FEE2E2', borderRadius: 8, padding: '10px 12px', color: '#991B1B' },
  refunding: { background: '#FFEDD5', borderRadius: 8, padding: '10px 12px', color: '#9A3412' },
  desc: { margin: '4px 0 0', fontSize: 13, color: '#4B5563', lineHeight: 1.5 },
};
