/**
 * 화면 위에 뜨는 설정 창의 틀 — 제목·닫기·배경 클릭으로 닫기
 */
import type { ReactNode } from 'react';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.head}>
          <h2 style={styles.title}>{title}</h2>
          <button onClick={onClose} style={styles.close} aria-label="닫기">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const styles = {
  backdrop: {
    position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 100,
  },
  modal: {
    background: 'white', borderRadius: 12, padding: 20, maxWidth: 460, width: '100%',
    maxHeight: '90vh', overflowY: 'auto' as const,
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { margin: 0, fontSize: 18 },
  close: {
    border: 'none', background: 'none', fontSize: 18, color: '#9CA3AF', cursor: 'pointer', padding: 4, lineHeight: 1,
  },
};
