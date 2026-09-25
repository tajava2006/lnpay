/**
 * 남은 시간
 *
 * ⚠️ **마감이 있는데 안 보이면 없는 것과 같다.** 이 트랙은 마감을 넘기면
 * 보증금이 몰수되는 구간이 여럿이라(입금 컨펌 · 사전서명 · 계좌 전달 · 원화 송금 — 길이는
 * `timing.ts`), "얼마 남았는지"가 화면에 없으면 유저는 자기가 쫓기는 줄도 모른다.
 *
 * 무엇을 잃는지는 **보는 사람 입장에서** 적는다(`role`) — 내 마감이면 내 보증금, 상대 마감이면 상대방 보증금.
 *
 * 어느 시계가 도는지는 `currentOnchainDeadline`이 한 곳에서 정한다 —
 * `presigned`는 **한 상태 안에서 주인이 바뀌므로**(O-013) 화면이 스스로
 * 판단하게 두면 갈린다.
 */
import { useEffect, useState } from 'react';
import { currentOnchainDeadline, type DeadlineViewer, type OnchainOrder } from '@sajwo-tracker/shared/onchain';

function remainText(seconds: number): string {
  if (seconds <= 0) return '마감 지남';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}시간 ${m}분 남음`;
  if (m > 0) return `${m}분 ${s}초 남음`;
  return `${s}초 남음`;
}

export function DeadlineCountdown({ order, role }: { order: OnchainOrder; role: DeadlineViewer }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const deadline = currentOnchainDeadline(order, role);
  if (!deadline) return null;

  const remain = deadline.at - now;
  // 10분 미만이면 빨강, 1시간 미만이면 주황 — 급한 걸 색으로 먼저 알린다.
  const tone = remain <= 0 ? styles.over
    : remain < 600 ? styles.urgent
    : remain < 3600 ? styles.soon
    : styles.calm;

  return (
    <div style={{ ...styles.box, ...tone }}>
      <span style={styles.label}>{deadline.label}</span>
      <strong style={styles.remain}>{remainText(remain)}</strong>
      {deadline.penalty && remain < 3600 && (
        <span style={styles.penalty}>{deadline.penalty}</span>
      )}
    </div>
  );
}

const styles = {
  box: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const,
    borderRadius: 8, padding: '8px 10px', fontSize: 13,
  },
  label: { fontSize: 12, opacity: 0.8 },
  remain: { fontSize: 14 },
  penalty: { fontSize: 11, width: '100%', opacity: 0.9, lineHeight: 1.5 },
  calm: { background: '#F3F4F6', color: '#374151' },
  soon: { background: '#FFF7ED', color: '#9A3412' },
  urgent: { background: '#FEF2F2', color: '#991B1B' },
  over: { background: '#FEE2E2', color: '#7F1D1D' },
};
