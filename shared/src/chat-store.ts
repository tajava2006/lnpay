/**
 * 리액티브 채팅 스토어 (인메모리)
 *
 * useSyncExternalStore 호환.
 * 디테일 페이지 진입 시 IDB 로드 → 릴레이 라이브 수신 → UI 자동 반영.
 * 디테일 페이지 이탈 시 인메모리 데이터 해제.
 */
import type { ChatMessage } from './types';
import { idbUpsertMessage, idbGetMessagesByOrderId } from './idb';

type ChatMap = Record<string, ChatMessage[]>;
type Listener = () => void;

let chats: ChatMap = {};
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// ── useSyncExternalStore 호환 API ──────────────────

export function subscribeChatStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getChatSnapshot(): ChatMap {
  return chats;
}

// ── 뮤테이션 API ───────────────────────────────────

/**
 * 채팅 메시지를 추가한다.
 * eventId 기반 중복 제거 + createdAt 오름차순 정렬.
 * IDB에도 fire-and-forget으로 저장.
 */
export function addMessage(msg: ChatMessage): void {
  const existing = chats[msg.orderId] ?? [];
  if (existing.some(m => m.eventId === msg.eventId)) return;

  const updated = [...existing, msg].sort((a, b) => a.createdAt - b.createdAt);
  chats = { ...chats, [msg.orderId]: updated };
  notify();

  void idbUpsertMessage(msg).catch(err => {
    console.warn('[ChatStore] IDB upsert failed for', msg.eventId, err);
  });
}

/**
 * IDB에서 기존 메시지를 로드한다.
 * 디테일 페이지 진입 시 호출.
 */
export async function loadFromIdb(orderId: string): Promise<void> {
  try {
    const messages = await idbGetMessagesByOrderId(orderId);
    if (messages.length === 0) return;

    const existing = chats[orderId] ?? [];
    const existingIds = new Set(existing.map(m => m.eventId));
    const newMessages = messages.filter(m => !existingIds.has(m.eventId));
    if (newMessages.length === 0) return;

    const merged = [...existing, ...newMessages].sort((a, b) => a.createdAt - b.createdAt);
    chats = { ...chats, [orderId]: merged };
    notify();
  } catch (err) {
    console.warn('[ChatStore] IDB load failed for', orderId, err);
  }
}

/**
 * 특정 오더의 채팅 데이터를 메모리에서 해제한다.
 * 디테일 페이지 이탈 시 호출.
 */
export function clearMessages(orderId: string): void {
  if (!chats[orderId]) return;
  const { [orderId]: _, ...rest } = chats;
  chats = rest;
  notify();
}
