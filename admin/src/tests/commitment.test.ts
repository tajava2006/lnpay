import { describe, it, expect } from 'vitest';
import { sha256Hex } from '@sajwo-tracker/shared';

describe('sha256Hex (commitment 검증)', () => {
  it('같은 입력은 항상 같은 해시', async () => {
    const input = JSON.stringify({ bank: '국민', account: '123-456', name: '홍길동' });
    const h1 = await sha256Hex(input);
    const h2 = await sha256Hex(input);
    expect(h1).toBe(h2);
  });

  it('다른 입력은 다른 해시', async () => {
    const h1 = await sha256Hex(JSON.stringify({ bank: '국민', account: '123-456' }));
    const h2 = await sha256Hex(JSON.stringify({ bank: '신한', account: '123-456' }));
    expect(h1).not.toBe(h2);
  });

  it('계좌 정보 필드 순서가 바뀌면 다른 해시 (JSON.stringify 순서 의존)', async () => {
    const h1 = await sha256Hex(JSON.stringify({ bank: '국민', account: '123' }));
    const h2 = await sha256Hex(JSON.stringify({ account: '123', bank: '국민' }));
    expect(h1).not.toBe(h2);
  });

  it('hex 문자열 반환 (64자)', async () => {
    const hash = await sha256Hex('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('commitment 불일치 — 계좌 번호 1자리 다르면 해시 불일치', async () => {
    const real = JSON.stringify({ bank: '국민', account: '123-456', name: '홍길동' });
    const tampered = JSON.stringify({ bank: '국민', account: '123-457', name: '홍길동' });
    const h1 = await sha256Hex(real);
    const h2 = await sha256Hex(tampered);
    expect(h1).not.toBe(h2);
  });
});
