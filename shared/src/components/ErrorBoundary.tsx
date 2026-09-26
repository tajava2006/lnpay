/**
 * 렌더 중 예외를 이 경계 안에 가둔다
 *
 * 경계가 없으면 카드 하나의 예외가 **앱 전체를 흰 화면**으로 만든다 — 헤더의 🔑(키 보기)와 온체인 회수 화면까지
 * 같이 사라진다. 돈이 묶인 순간에 탈출구가 없어지는 것이다. 그래서 경계는 잘게 둔다: 화면 단위, 카드 단위,
 * 그리고 회수처럼 **다른 칸이 깨져도 남아야 하는 칸**은 따로.
 *
 * 렌더·생명주기 예외만 잡는다(React 규칙). 이벤트 핸들러·비동기 실패는 각자 처리한다.
 */
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** 무엇이 깨졌는지 — 대체 화면과 콘솔에 찍힌다 */
  label: string;
  children: ReactNode;
  /** 대체 화면 아래에 덧붙일 것 (예: 새로고침 버튼) */
  extra?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[${this.props.label}] 화면을 그리지 못했다`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={styles.box}>
        <strong style={styles.title}>화면을 그리다 문제가 생겼습니다 — {this.props.label}</strong>
        <p style={styles.message}>{error.message}</p>
        <div style={styles.actions}>
          <button type="button" style={styles.button} onClick={() => this.setState({ error: null })}>다시 그리기</button>
          {this.props.extra}
        </div>
      </div>
    );
  }
}

/** 컴포넌트를 경계로 감싼다 — 목록의 카드 하나가 깨져도 나머지는 그대로 */
export function guarded<P extends object>(Inner: ComponentType<P>, label: string): (props: P) => ReactNode {
  function Guarded(props: P) {
    return (
      <ErrorBoundary label={label}>
        <Inner {...props} />
      </ErrorBoundary>
    );
  }
  Guarded.displayName = `Guarded(${Inner.displayName ?? Inner.name})`;
  return Guarded;
}

const styles = {
  box: {
    padding: 12, border: '1px solid #FCA5A5', borderRadius: 8, background: '#FEF2F2',
    display: 'flex', flexDirection: 'column' as const, gap: 6,
  },
  title: { fontSize: 14, color: '#991B1B' },
  message: { margin: 0, fontSize: 12, color: '#7F1D1D', wordBreak: 'break-all' as const },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' as const },
  button: {
    padding: '6px 10px', fontSize: 13, border: '1px solid #FCA5A5', borderRadius: 6,
    background: '#fff', color: '#991B1B', cursor: 'pointer',
  },
};
