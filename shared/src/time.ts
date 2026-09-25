/**
 * 시각·남은 시간 문구 — 앱들이 같은 말을 하게 한 곳에 둔다
 *
 * 카운트다운 문구가 카드·오더북·온체인 마감에 세 벌 있었고 "기한 지남"·"만료됨"·"마감 지남"처럼 조금씩 달랐다.
 */

/** 지금 (unix초) */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 남은 시간 — "3시간 12분 남음" · "4분 30초 남음" · "12초 남음".
 * @param past 이미 지났을 때의 말 ("기한 지남", "마감 지남" …)
 */
export function remainingText(seconds: number, past: string): string {
  if (seconds <= 0) return past;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}시간 ${m}분 남음`;
  if (m > 0) return `${m}분 ${s}초 남음`;
  return `${s}초 남음`;
}

/** 날짜·시각 (한국어 로캘). 없으면 '—' */
export function dateTimeText(sec: number | undefined): string {
  return sec ? new Date(sec * 1000).toLocaleString('ko-KR') : '—';
}
