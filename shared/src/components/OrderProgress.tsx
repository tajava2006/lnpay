import type { OrderState } from '../constants';
import { resolveProgress, type ProgressRole, type ResolvedStep } from '../order-progress';

interface Props {
  /** 이 화면을 보는 사람의 역할 */
  role: ProgressRole;
  state: OrderState;
  /** escrowed 단계에서 고객이 계좌정보를 이미 보냈는지 — 누구 차례인지 갈린다 */
  accountInfoSent?: boolean;
}

const ACTOR_LABEL: Record<string, string> = {
  customer: '고객',
  sponsor: '후원자',
  admin: '에스크로',
};

/**
 * 거래 단계 사다리. 고객·후원자가 같은 컴포넌트를 role만 바꿔 쓴다.
 *
 * 각 단계의 할 일을 늘 펼쳐두어 사용설명서 역할을 겸한다 —
 * 처음 쓰는 사람이 다음에 뭘 해야 하는지 따로 찾아보지 않아도 되게.
 */
export function OrderProgress({ role, state, accountInfoSent }: Props) {
  const { steps, terminal, total } = resolveProgress(role, state, { accountInfoSent });

  return (
    <div style={styles.container}>
      <div style={styles.headerRow}>
        <span style={styles.header}>거래 진행도</span>
        <span style={styles.headerCount}>총 {total}단계</span>
      </div>

      {terminal && (
        <div style={styles.terminal}>
          <span style={styles.terminalLabel}>{terminal.label}</span>
          <span style={styles.terminalDesc}>{terminal.description}</span>
        </div>
      )}

      <ol style={styles.list}>
        {steps.map((step) => (
          <Step key={step.state} step={step} isLast={step.index === total - 1} />
        ))}
      </ol>
    </div>
  );
}

function Step({ step, isLast }: { step: ResolvedStep; isLast: boolean }) {
  const done = step.status === 'done';
  const current = step.status === 'current';

  const markerColor = done ? '#059669' : current ? '#4F46E5' : '#D1D5DB';
  const titleColor = current ? '#111827' : done ? '#374151' : '#9CA3AF';

  return (
    <li style={styles.item}>
      <div style={styles.rail}>
        <div style={{ ...styles.marker, background: markerColor }}>
          {done ? '✓' : step.index + 1}
        </div>
        {!isLast && (
          <div style={{ ...styles.connector, background: done ? '#059669' : '#E5E7EB' }} />
        )}
      </div>

      <div style={styles.body}>
        <div style={styles.titleRow}>
          <span style={{ ...styles.title, color: titleColor, fontWeight: current ? 700 : 500 }}>
            {step.title}
          </span>
          {current && (
            step.isMyTurn
              ? <span style={styles.turnMine}>지금 당신 차례</span>
              : <span style={styles.turnOther}>{ACTOR_LABEL[step.actor]} 대기 중</span>
          )}
        </div>

        <ul style={styles.actions}>
          {step.actions.map((action, i) => (
            <li
              key={i}
              style={{
                ...styles.action,
                color: current ? '#374151' : '#9CA3AF',
              }}
            >
              {action.text}
              {action.optional && <span style={styles.optional}>요구될 수 있음</span>}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

const styles = {
  container: {
    border: '1px solid #E5E7EB',
    borderRadius: 10,
    padding: '14px 16px',
    background: '#FCFCFD',
  },
  headerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 12,
  },
  header: {
    fontSize: 13,
    fontWeight: 600 as const,
    color: '#374151',
  },
  headerCount: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  terminal: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    padding: '10px 12px',
    marginBottom: 12,
    background: '#FEF2F2',
    border: '1px solid #FECACA',
    borderRadius: 8,
  },
  terminalLabel: {
    fontSize: 13,
    fontWeight: 700 as const,
    color: '#B91C1C',
  },
  terminalDesc: {
    fontSize: 12,
    color: '#7F1D1D',
    lineHeight: 1.5,
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  },
  item: {
    display: 'flex',
    gap: 12,
    alignItems: 'stretch',
  },
  rail: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    flexShrink: 0,
  },
  marker: {
    width: 22,
    height: 22,
    borderRadius: '50%',
    color: 'white',
    fontSize: 12,
    fontWeight: 700 as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  connector: {
    width: 2,
    flex: 1,
    minHeight: 12,
    margin: '2px 0',
  },
  body: {
    flex: 1,
    paddingBottom: 14,
    minWidth: 0,
  },
  titleRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
    gap: 6,
    minHeight: 22,
  },
  title: {
    fontSize: 14,
  },
  turnMine: {
    fontSize: 11,
    fontWeight: 700 as const,
    color: 'white',
    background: '#4F46E5',
    borderRadius: 999,
    padding: '2px 8px',
  },
  turnOther: {
    fontSize: 11,
    fontWeight: 600 as const,
    color: '#6B7280',
    background: '#F3F4F6',
    borderRadius: 999,
    padding: '2px 8px',
  },
  actions: {
    listStyle: 'disc',
    margin: '4px 0 0',
    padding: '0 0 0 18px',
  },
  action: {
    fontSize: 12,
    lineHeight: 1.6,
  },
  optional: {
    display: 'inline-block',
    marginLeft: 6,
    fontSize: 10,
    fontWeight: 600 as const,
    color: '#92400E',
    background: '#FEF3C7',
    borderRadius: 4,
    padding: '1px 5px',
    whiteSpace: 'nowrap' as const,
  },
};
