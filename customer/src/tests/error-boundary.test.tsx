/**
 * 렌더 예외 가두기
 *
 * 경계가 없으면 카드 하나의 예외가 앱 전체를 흰 화면으로 만든다(🔑 키 보기·온체인 회수까지 사라진다).
 * 여기서는 경계가 **옆 칸을 살려 두는지**를 실제 렌더로 본다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary, guarded } from '@sajwo-tracker/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Boom({ when }: { when: boolean }): never | string {
  if (when) throw new Error('터졌다');
  return '멀쩡함';
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('깨진 칸만 대체 화면이 되고 옆 칸(회수)은 그대로 — 온체인 카드의 모양', () => {
    act(() => root.render(
      <div>
        <ErrorBoundary label="이 거래 카드"><Boom when /></ErrorBoundary>
        <ErrorBoundary label="자금 회수"><span>회수 칸</span></ErrorBoundary>
      </div>,
    ));
    expect(host.textContent).toContain('이 거래 카드');
    expect(host.textContent).toContain('터졌다');
    expect(host.textContent).toContain('회수 칸');
  });

  it('목록의 카드 하나가 깨져도 나머지 카드는 그려진다 (guarded)', () => {
    const Card = guarded(Boom, '이 의뢰 카드');
    act(() => root.render(<div><Card when={false} /><Card when /><Card when={false} /></div>));
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.textContent?.match(/멀쩡함/g)).toHaveLength(2);
  });

  it('다시 그리기 — 원인이 사라졌으면 원래 화면으로 돌아온다', () => {
    let broken = true;
    function Flaky() {
      if (broken) throw new Error('잠깐 깨짐');
      return <span>복구됨</span>;
    }
    act(() => root.render(<ErrorBoundary label="화면"><Flaky /></ErrorBoundary>));
    expect(host.textContent).toContain('잠깐 깨짐');
    broken = false;
    act(() => host.querySelector('button')!.click());
    expect(host.textContent).toContain('복구됨');
  });
});
