/**
 * 로그 — JSON 한 줄씩 stdout으로. docker logs가 받는다.
 *
 * 비밀(시드·nsec·프리이미지·계좌)은 **절대 넘기지 않는다.** 로그는 오래 남고 여기저기 복사된다.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(write: (line: string) => void = line => process.stdout.write(line + '\n')): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

/** 테스트용 — 아무것도 안 쓴다 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
