/**
 * 어드민 화면 공용 스타일 — 화면마다 같은 카드·표·버튼이 복붙돼 있었다
 *
 * 화면 고유의 것은 그 파일의 `styles`에 둔다. 여기는 두 화면 이상이 **같은 값**으로 쓰는 것만.
 */
export const ui = {
  column: { display: 'flex', flexDirection: 'column' as const, gap: 16 },
  card: { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column' as const, gap: 12 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const },
  h2: { fontSize: 17, margin: 0, color: '#333' },
  h3: { fontSize: 15, margin: 0, color: '#333', display: 'flex', alignItems: 'baseline', gap: 8 },
  back: { alignSelf: 'flex-start', padding: '6px 12px', fontSize: 13, background: '#fff', color: '#374151', border: '1px solid #E5E7EB', borderRadius: 6, cursor: 'pointer' },
  badge: { padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600 as const },
  dl: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: 0, fontSize: 13, color: '#374151', wordBreak: 'break-all' as const },
  note: { fontSize: 12, color: '#6B7280', margin: 0, fontWeight: 400 as const },
  warnText: { color: '#B45309' },
  button: { padding: '8px 14px', fontSize: 13, fontWeight: 600 as const, background: '#4F46E5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  danger: { padding: '8px 14px', fontSize: 13, fontWeight: 600 as const, background: '#DC2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th: { textAlign: 'left' as const, fontSize: 12, color: '#6B7280', padding: '6px 8px', borderBottom: '1px solid #E5E7EB' },
  td: { padding: '8px', borderBottom: '1px solid #F3F4F6' },
};
