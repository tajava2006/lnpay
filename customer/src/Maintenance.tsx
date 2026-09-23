/**
 * 공사 중 안내
 *
 * 어드민을 브라우저에서 롱러닝 데몬으로 옮기는 동안 유저 앱을 닫아 둔다.
 * 이미 배포된 주소가 404가 되지 않게 이 화면 하나만 띄운다 — 구독도 저장소도
 * 건드리지 않는다(`main.tsx`가 앱을 아예 불러오지 않는다).
 */
export function Maintenance() {
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <p style={styles.brand}>페어바이</p>
        <h1 style={styles.title}>현재 공사 중입니다</h1>
        <p style={styles.body}>
          더 튼튼한 구조로 옮기고 있습니다.
          <br />
          준비가 끝나면 다시 열겠습니다.
        </p>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 16px',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    background: '#fff',
    borderRadius: 16,
    padding: '36px 28px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    textAlign: 'center' as const,
  },
  brand: { margin: 0, fontSize: 14, fontWeight: 600 as const, color: '#4F46E5' },
  title: { margin: '12px 0 16px', fontSize: 24, color: '#333' },
  body: { margin: 0, fontSize: 15, lineHeight: 1.7, color: '#666' },
};
