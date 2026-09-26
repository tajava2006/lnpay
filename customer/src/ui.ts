/**
 * 유저 앱 공용 스타일 — 두 화면 이상이 **같은 값**으로 쓰던 것만 모은다
 *
 * 화면 고유의 것은 그 파일의 `styles`에 둔다.
 */
export const ui = {
  /** 회색 안내 상자 (설치 안내·알림 설정) */
  panel: {
    padding: 16,
    background: '#F9FAFB',
    border: '1px solid #E5E7EB',
    borderRadius: 8,
    marginBottom: 12,
  },
  primaryButton: {
    padding: '9px 20px',
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  ghostButton: {
    padding: '7px 16px',
    background: 'transparent',
    color: '#6B7280',
    border: '1px solid #D1D5DB',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  /** 설정 창 첫 문단 */
  lead: { margin: '0 0 16px 0', fontSize: 14, lineHeight: 1.6, color: '#374151' },
  text: { margin: '0 0 12px 0', fontSize: 13, lineHeight: 1.6, color: '#4B5563' },
  subText: { margin: '0 0 12px 0', fontSize: 12, lineHeight: 1.6, color: '#9CA3AF' },
  errorText: { margin: '0 0 12px 0', fontSize: 13, lineHeight: 1.6, color: '#DC2626' },
  /** 노란 주의 상자 */
  tipBox: {
    padding: 12,
    background: '#FFFBEB',
    border: '1px solid #FDE68A',
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 1.6,
    color: '#78350F',
    marginBottom: 12,
  },
  empty: { fontSize: 14, color: '#6B7280', textAlign: 'center' as const, padding: '32px 0' },
  /** 오더 카드 머리의 금액·남은 시간·배지 줄 */
  price: { fontSize: 20, fontWeight: 600 as const, color: '#4F46E5' },
  timeLeft: { fontSize: 13, fontWeight: 500 as const },
  statusRow: { display: 'flex', flexWrap: 'wrap' as const, alignItems: 'center', gap: 6 },
};
