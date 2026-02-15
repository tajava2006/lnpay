/**
 * BTC/KRW 실시간 가격 추적 서비스
 *
 * 업비트, 빗썸, 코인원 세 거래소의 공개 WebSocket API에 동시 연결하여
 * BTC/KRW 가격을 실시간으로 수신한다. 하나가 고장나도 나머지로 동작.
 *
 * useSyncExternalStore 호환 API (subscribe/getSnapshot)를 제공한다.
 */

// ── 타입 ──────────────────────────────────────────

export interface ExchangeState {
  name: string;
  price: number | null;
  connected: boolean;
}

export interface PriceSnapshot {
  /** 연결된 거래소들의 중간값. 모두 끊기면 null */
  price: number | null;
  /** 각 거래소별 상태 */
  exchanges: ExchangeState[];
}

export interface PriceTracker {
  start(): void;
  stop(): void;
  /** useSyncExternalStore 용 subscribe */
  subscribe(listener: () => void): () => void;
  /** useSyncExternalStore 용 getSnapshot */
  getSnapshot(): PriceSnapshot;
}

// ── 거래소 연결 설정 ──────────────────────────────

interface ExchangeConfig {
  name: string;
  url: string;
  /** 연결 후 전송할 구독 메시지 */
  subscribeMessage: () => string;
  /** 수신 메시지에서 가격 추출. null이면 무시 (status 메시지 등) */
  parsePrice: (data: unknown) => number | null;
  /** binary 응답 여부 (업비트) */
  binary?: boolean;
  /** ping 간격 (ms). 0이면 ping 불필요 */
  pingIntervalMs: number;
  /** ping 메시지 */
  pingMessage?: () => string;
}

const EXCHANGES: ExchangeConfig[] = [
  {
    name: '업비트',
    url: 'wss://api.upbit.com/websocket/v1',
    subscribeMessage: () => JSON.stringify([
      { ticket: '0e66c0ac-7e13-43ef-91fb-2a87c2956c49' },
      { type: 'ticker', codes: ['KRW-BTC'] },
    ]),
    parsePrice: (data) => {
      const d = data as Record<string, unknown>;
      if (d.type === 'ticker' && typeof d.trade_price === 'number') {
        return d.trade_price;
      }
      return null;
    },
    binary: true,
    pingIntervalMs: 2 * 60 * 1000, // 2분
    pingMessage: () => 'PING',
  },
  {
    name: '빗썸',
    url: 'wss://pubwss.bithumb.com/pub/ws',
    subscribeMessage: () => JSON.stringify({
      type: 'ticker',
      symbols: ['BTC_KRW'],
      tickTypes: ['24H'],
    }),
    parsePrice: (data) => {
      const d = data as Record<string, unknown>;
      if (d.type === 'ticker') {
        const content = d.content as Record<string, unknown> | undefined;
        if (content && typeof content.closePrice === 'string') {
          const price = Number(content.closePrice);
          return Number.isNaN(price) ? null : price;
        }
      }
      return null;
    },
    pingIntervalMs: 3 * 60 * 1000, // 3분
    pingMessage: () => JSON.stringify({ type: 'ping' }),
  },
  {
    name: '코인원',
    url: 'wss://stream.coinone.co.kr',
    subscribeMessage: () => JSON.stringify({
      request_type: 'SUBSCRIBE',
      channel: 'TICKER',
      topic: {
        quote_currency: 'KRW',
        target_currency: 'BTC',
      },
    }),
    parsePrice: (data) => {
      const d = data as Record<string, unknown>;
      if (d.response_type === 'DATA') {
        const inner = d.data as Record<string, unknown> | undefined;
        if (inner && typeof inner.last === 'string') {
          const price = Number(inner.last);
          return Number.isNaN(price) ? null : price;
        }
      }
      return null;
    },
    pingIntervalMs: 20 * 60 * 1000, // 20분 (30분 timeout 전에 ping)
    pingMessage: () => JSON.stringify({ request_type: 'PING' }),
  },
];

const RECONNECT_DELAY_MS = 5000;
const decoder = new TextDecoder('utf-8');

// ── 구현 ──────────────────────────────────────────

export function createPriceTracker(): PriceTracker {
  const listeners = new Set<() => void>();

  // 거래소별 상태
  const states: ExchangeState[] = EXCHANGES.map(ex => ({
    name: ex.name,
    price: null,
    connected: false,
  }));

  let snapshot: PriceSnapshot = { price: null, exchanges: [...states] };
  let running = false;

  // WebSocket 인스턴스 + 재연결 타이머 + ping 타이머
  const sockets: (WebSocket | null)[] = EXCHANGES.map(() => null);
  const reconnectTimers: (ReturnType<typeof setTimeout> | null)[] = EXCHANGES.map(() => null);
  const pingTimers: (ReturnType<typeof setInterval> | null)[] = EXCHANGES.map(() => null);

  function notify() {
    // snapshot을 새 참조로 생성 (useSyncExternalStore가 변경 감지)
    const prices = states.filter(s => s.price !== null).map(s => s.price!);
    snapshot = {
      price: median(prices),
      exchanges: states.map(s => ({ ...s })),
    };
    for (const listener of listeners) {
      listener();
    }
  }

  function connectExchange(index: number) {
    if (!running) return;

    const config = EXCHANGES[index];
    const state = states[index];

    // 기존 연결 정리
    cleanupSocket(index);

    try {
      const ws = new WebSocket(config.url);
      sockets[index] = ws;

      if (config.binary) {
        ws.binaryType = 'arraybuffer';
      }

      ws.addEventListener('open', () => {
        console.log(`[Price] ${config.name} 연결됨`);
        state.connected = true;
        ws.send(config.subscribeMessage());
        notify();

        // ping 타이머 설정
        if (config.pingIntervalMs > 0 && config.pingMessage) {
          const msg = config.pingMessage;
          pingTimers[index] = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(msg());
            }
          }, config.pingIntervalMs);
        }
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        let parsed: unknown;
        try {
          if (config.binary && event.data instanceof ArrayBuffer) {
            parsed = JSON.parse(decoder.decode(event.data));
          } else if (typeof event.data === 'string') {
            parsed = JSON.parse(event.data);
          } else {
            return;
          }
        } catch {
          return;
        }

        const price = config.parsePrice(parsed);
        if (price !== null) {
          state.price = price;
          notify();
        }
      });

      ws.addEventListener('close', () => {
        // 이미 교체된 소켓의 stale close 이벤트는 무시
        if (sockets[index] !== ws) return;

        console.log(`[Price] ${config.name} 연결 종료`);
        sockets[index] = null;
        state.connected = false;
        cleanupPing(index);
        notify();
        scheduleReconnect(index);
      });

      ws.addEventListener('error', () => {
        console.warn(`[Price] ${config.name} 오류`);
        ws.close();
      });
    } catch (err) {
      console.warn(`[Price] ${config.name} 연결 실패:`, err);
      scheduleReconnect(index);
    }
  }

  function cleanupSocket(index: number) {
    const ws = sockets[index];
    if (ws) {
      sockets[index] = null; // close 이벤트보다 먼저 null 설정 → stale handler 무시
      ws.close();
    }
    cleanupPing(index);
  }

  function cleanupPing(index: number) {
    if (pingTimers[index] !== null) {
      clearInterval(pingTimers[index]!);
      pingTimers[index] = null;
    }
  }

  function scheduleReconnect(index: number) {
    if (!running) return;
    if (reconnectTimers[index] !== null) return;
    reconnectTimers[index] = setTimeout(() => {
      reconnectTimers[index] = null;
      connectExchange(index);
    }, RECONNECT_DELAY_MS);
  }

  return {
    start() {
      if (running) return;
      running = true;
      for (let i = 0; i < EXCHANGES.length; i++) {
        connectExchange(i);
      }
    },

    stop() {
      running = false;
      for (let i = 0; i < EXCHANGES.length; i++) {
        cleanupSocket(i);
        if (reconnectTimers[i] !== null) {
          clearTimeout(reconnectTimers[i]!);
          reconnectTimers[i] = null;
        }
        states[i].connected = false;
        states[i].price = null;
      }
      notify();
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot() {
      return snapshot;
    },
  };
}

// ── 유틸 ──────────────────────────────────────────

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}
