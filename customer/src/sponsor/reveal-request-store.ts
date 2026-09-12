/**
 * 계좌정보 공개 요청 저장소
 *
 * Admin이 분쟁 중재 중에 "그때 받은 계좌를 공개해 달라"고 보낸 요청을 추적한다.
 *
 * 왜 필요한가: 공개는 커밋먼트 대조를 위한 분쟁 대응 수단인데, 예전에는 후원자
 * 화면에서 `remitted` 상태면 버튼이 그냥 보였다. `remitted`는 "원화 송금했어요"를
 * 누른 직후의 **정상 상태**라, 후원자가 흐름의 일부인 줄 알고 계좌번호를 Admin에게
 * 그냥 쏘는 일이 실제로 생겼다. 분쟁이 아닌데 평문 계좌가 한 명 더에게 건너간다.
 *
 * 상태만으로는 분쟁 여부를 알 수 없으므로(FSM에 '분쟁 중'이 없다) Admin의 명시적
 * 요청을 신호로 쓴다. 새로고침을 넘겨야 하므로 localStorage에 남긴다.
 */

type Listener = () => void;

/** orderId → 요청 수신 시각(unix seconds) */
type RevealRequestMap = Record<string, number>;

const STORAGE_KEY = 'sponsor:reveal-requests';

let requests: RevealRequestMap = load();
const listeners = new Set<Listener>();

function load(): RevealRequestMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(requests));
}

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeRevealRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRevealRequestSnapshot(): RevealRequestMap {
  return requests;
}

/** Admin이 공개를 요청했음을 기록한다. */
export function setRevealRequested(orderId: string, at: number): void {
  if (requests[orderId]) return;
  requests = { ...requests, [orderId]: at };
  save();
  notify();
}

export function isRevealRequested(orderId: string): boolean {
  return requests[orderId] !== undefined;
}
