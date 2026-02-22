import { useEffect, useState } from 'react';

interface ToastMessage {
  id: number;
  title: string;
  message: string;
  onClick?: () => void;
}

let nextId = 0;
const toastListeners = new Set<(msg: ToastMessage) => void>();

/** Toast 표시 (어디서든 호출 가능) */
export function showToast(options: { title: string; message: string; onClick?: () => void }): void {
  const msg: ToastMessage = { id: nextId++, ...options };
  for (const listener of toastListeners) listener(msg);
}

/** Toast 컨테이너 (Dashboard에 1회 마운트) */
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const handler = (msg: ToastMessage) => {
      setToasts(prev => [...prev, msg]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== msg.id)), 5000);
    };
    toastListeners.add(handler);
    return () => { toastListeners.delete(handler); };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div style={styles.container}>
      {toasts.map(t => (
        <div
          key={t.id}
          onClick={t.onClick}
          style={{
            ...styles.toast,
            ...(t.onClick ? { cursor: 'pointer' } : {}),
          }}
        >
          <div style={styles.icon}>&#9889;</div>
          <div>
            <div style={styles.title}>{t.title}</div>
            <div style={styles.message}>{t.message}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

const styles = {
  container: {
    position: 'fixed' as const,
    top: 16,
    right: 16,
    zIndex: 10000,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  toast: {
    background: 'linear-gradient(135deg, #F59E0B, #EF4444)',
    color: 'white',
    borderRadius: 12,
    padding: '12px 16px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    display: 'flex',
    alignItems: 'flex-start' as const,
    gap: 10,
    maxWidth: 320,
    animation: 'toastIn 0.3s ease-out',
  },
  icon: {
    fontSize: 18,
    flexShrink: 0,
  },
  title: {
    fontWeight: 600 as const,
    fontSize: 14,
    marginBottom: 2,
  },
  message: {
    fontSize: 13,
    opacity: 0.9,
  },
};
