/**
 * 체인 어댑터 (PLAN-ONCHAIN-TRACK §11 P2)
 *
 * 여기서 지키는 건 하나다 — **조회가 실패하면 '모름'이지 '없음'이 아니다.**
 * `FundStatus`에서 겪은 사고가 그것이고(조회 실패를 '없음'으로 뭉갬), 온체인에서
 * 같은 실수를 하면 **돈이 있는 주소를 비었다고 보고 취소**하게 된다.
 *
 * 네트워크를 타지 않는다 — `fetchImpl`을 주입해 응답 픽스처로만 돌린다.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_MEMPOOL_API, MempoolChainAdapter } from '../onchain/chain';

const ADDR = 'bc1plh936afrnp3y86wlrmd6k73msg3ke4tnv9lrsvut790dkdmcm8asckq3jn';
const TXID = 'a'.repeat(64);

/** 경로별 응답을 미리 짜두는 가짜 fetch. 안 짜둔 경로를 부르면 테스트가 깨진다. */
function fakeFetch(routes: Record<string, { body: string; status?: number } | Error>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const key = Object.keys(routes).find(k => url.endsWith(k));
    if (!key) throw new Error(`테스트가 준비하지 않은 경로: ${url}`);
    const r = routes[key]!;
    if (r instanceof Error) throw r;
    return new Response(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

function adapter(routes: Parameters<typeof fakeFetch>[0]) {
  const { impl, calls } = fakeFetch(routes);
  return {
    chain: new MempoolChainAdapter({ network: 'mainnet', fetchImpl: impl }),
    calls,
  };
}

const TIP = { body: '900000' };

describe('주소 자금 조회', () => {
  it('컨펌과 멤풀을 가르고 컨펌 수를 팁에서 계산한다', async () => {
    const { chain } = adapter({
      '/blocks/tip/height': TIP,
      [`/address/${ADDR}/utxo`]: {
        body: JSON.stringify([
          { txid: TXID, vout: 0, value: 50_000, status: { confirmed: true, block_height: 899_998 } },
          { txid: 'b'.repeat(64), vout: 1, value: 7_000, status: { confirmed: false } },
        ]),
      },
    });

    const res = await chain.getAddressFunds(ADDR);
    expect(res.known).toBe(true);
    if (!res.known) return;
    expect(res.value.confirmed).toEqual([
      { txid: TXID, vout: 0, valueSat: 50_000, confirmations: 3 },
    ]);
    expect(res.value.mempool).toHaveLength(1);
    expect(res.value.mempool[0]!.confirmations).toBe(0);
  });

  it('빈 주소는 "모름"이 아니라 "없음"이다', async () => {
    const { chain } = adapter({
      '/blocks/tip/height': TIP,
      [`/address/${ADDR}/utxo`]: { body: '[]' },
    });
    const res = await chain.getAddressFunds(ADDR);
    expect(res).toEqual({ known: true, value: { confirmed: [], mempool: [] } });
  });

  /**
   * ⚠️ 여기가 이 파일의 핵심이다. 팁 높이만 실패했다고 컨펌 수를 0으로 뭉개면
   * "아직 컨펌 안 됐다"는 **거짓말**이 되고, 그 거짓말은 취소·몰수로 이어진다.
   */
  it('팁 높이 조회가 실패하면 전체가 "모름"이다', async () => {
    const { chain } = adapter({
      '/blocks/tip/height': { body: 'nope', status: 500 },
      [`/address/${ADDR}/utxo`]: {
        body: JSON.stringify([
          { txid: TXID, vout: 0, value: 50_000, status: { confirmed: true, block_height: 899_998 } },
        ]),
      },
    });
    const res = await chain.getAddressFunds(ADDR);
    expect(res.known).toBe(false);
  });

  it('UTXO 조회가 실패하면 "모름"이다', async () => {
    const { chain } = adapter({
      '/blocks/tip/height': TIP,
      [`/address/${ADDR}/utxo`]: { body: 'upstream down', status: 502 },
    });
    const res = await chain.getAddressFunds(ADDR);
    expect(res.known).toBe(false);
    if (res.known) return;
    expect(res.reason).toMatch(/502/);
  });

  it('네트워크가 던지면 "모름"이다 (타임아웃 포함)', async () => {
    const { chain } = adapter({
      '/blocks/tip/height': TIP,
      [`/address/${ADDR}/utxo`]: new Error('The operation was aborted due to timeout'),
    });
    const res = await chain.getAddressFunds(ADDR);
    expect(res.known).toBe(false);
    if (res.known) return;
    expect(res.reason).toMatch(/timeout/i);
  });

  /** 모르는 모양을 대충 넘기면 금액이 `undefined`인 UTXO가 판정에 들어간다. */
  it('응답 모양이 다르면 "모름"이다', async () => {
    for (const body of ['{"utxos":[]}', '[{"txid":1}]', 'not json']) {
      const { chain } = adapter({
        '/blocks/tip/height': TIP,
        [`/address/${ADDR}/utxo`]: { body },
      });
      const res = await chain.getAddressFunds(ADDR);
      expect(res.known, body).toBe(false);
    }
  });

  it('confirmed인데 block_height가 없으면 멤풀로 본다 (컨펌 수를 지어내지 않는다)', async () => {
    const { chain } = adapter({
      '/blocks/tip/height': TIP,
      [`/address/${ADDR}/utxo`]: {
        body: JSON.stringify([{ txid: TXID, vout: 0, value: 1, status: { confirmed: true } }]),
      },
    });
    const res = await chain.getAddressFunds(ADDR);
    expect(res.known).toBe(true);
    if (!res.known) return;
    expect(res.value.confirmed).toHaveLength(0);
    expect(res.value.mempool).toHaveLength(1);
  });
});

describe('tx 상태 조회 (우리가 뿌린 종결 tx용)', () => {
  it('컨펌되면 컨펌 수를 준다', async () => {
    const { chain } = adapter({
      '/blocks/tip/height': TIP,
      [`/tx/${TXID}`]: { body: JSON.stringify({ status: { confirmed: true, block_height: 899_991 } }) },
    });
    const res = await chain.getTxStatus(TXID);
    expect(res).toEqual({ known: true, value: { confirmed: true, confirmations: 10, blockHeight: 899_991 } });
  });

  it('멤풀이면 confirmed=false', async () => {
    const { chain } = adapter({
      '/blocks/tip/height': TIP,
      [`/tx/${TXID}`]: { body: JSON.stringify({ status: { confirmed: false } }) },
    });
    const res = await chain.getTxStatus(TXID);
    expect(res).toEqual({ known: true, value: { confirmed: false, confirmations: 0 } });
  });

  /** 404는 "그런 tx 없다"로 읽고 싶어지지만, 릴레이·프록시 오류도 404로 온다. */
  it('404도 "모름"이다', async () => {
    const { chain } = adapter({
      '/blocks/tip/height': TIP,
      [`/tx/${TXID}`]: { body: 'Transaction not found', status: 404 },
    });
    const res = await chain.getTxStatus(TXID);
    expect(res.known).toBe(false);
  });
});

describe('수수료 추정', () => {
  it('sat/vB 다섯 단계를 준다', async () => {
    const { chain } = adapter({
      '/v1/fees/recommended': {
        body: JSON.stringify({
          fastestFee: 12, halfHourFee: 9, hourFee: 6, economyFee: 3, minimumFee: 1,
        }),
      },
    });
    const res = await chain.getFeeEstimates();
    expect(res).toEqual({
      known: true,
      value: { fastest: 12, halfHour: 9, hour: 6, economy: 3, minimum: 1 },
    });
  });

  /** 0이나 음수를 그대로 쓰면 절대 안 잡히는 tx를 만든다. */
  it('비정상 값은 "모름"이다', async () => {
    for (const body of [
      JSON.stringify({ fastestFee: 0, halfHourFee: 9, hourFee: 6, economyFee: 3, minimumFee: 1 }),
      JSON.stringify({ fastestFee: 12, halfHourFee: 9, hourFee: 6, economyFee: 3 }),
      JSON.stringify({ fastestFee: '12' }),
    ]) {
      const { chain } = adapter({ '/v1/fees/recommended': { body } });
      expect((await chain.getFeeEstimates()).known, body).toBe(false);
    }
  });
});

describe('팁 높이', () => {
  it('평문 숫자를 읽는다', async () => {
    const { chain } = adapter({ '/blocks/tip/height': { body: '870123\n' } });
    expect(await chain.getTipHeight()).toEqual({ known: true, value: 870_123 });
  });

  it('숫자가 아니면 "모름"이다', async () => {
    for (const body of ['<html>502</html>', '0', '-1', '']) {
      const { chain } = adapter({ '/blocks/tip/height': { body } });
      expect((await chain.getTipHeight()).known, body).toBe(false);
    }
  });
});

describe('브로드캐스트', () => {
  it('txid를 돌려준다', async () => {
    const { chain, calls } = adapter({ '/tx': { body: TXID } });
    const res = await chain.broadcastTx('0200000001ab');
    expect(res).toEqual({ known: true, value: TXID });
    expect(calls[0]).toMatch(/^POST /);
  });

  /** 네트워크에 나가기 전에 막는다 — 잘못된 입력으로 노드를 때릴 이유가 없다. */
  it('16진이 아니면 요청도 안 보낸다', async () => {
    const { chain, calls } = adapter({ '/tx': { body: TXID } });
    const res = await chain.broadcastTx('nothex!');
    expect(res.known).toBe(false);
    expect(calls).toHaveLength(0);
  });

  /** 노드가 거부한 이유(수수료 부족·중복 등)가 화면까지 가야 한다. */
  it('거부 사유를 그대로 전달한다', async () => {
    const { chain } = adapter({
      '/tx': { body: 'sendrawtransaction RPC error: min relay fee not met', status: 400 },
    });
    const res = await chain.broadcastTx('0200000001ab');
    expect(res.known).toBe(false);
    if (res.known) return;
    expect(res.reason).toMatch(/min relay fee/);
  });

  it('응답이 txid가 아니면 성공으로 치지 않는다', async () => {
    const { chain } = adapter({ '/tx': { body: 'OK' } });
    expect((await chain.broadcastTx('0200000001ab')).known).toBe(false);
  });
});

describe('설정', () => {
  it('네트워크별 기본 엔드포인트', () => {
    expect(DEFAULT_MEMPOOL_API.mainnet).toBe('https://mempool.space/api');
    expect(DEFAULT_MEMPOOL_API.signet).toBe('https://mempool.space/signet/api');
  });

  /** 공개 인스턴스가 우리 IP를 차단한 적이 있다(2026-09-04). 갈아탈 수 있어야 한다. */
  it('baseUrl을 갈아끼울 수 있고 끝 슬래시를 정규화한다', async () => {
    const { impl, calls } = fakeFetch({ '/blocks/tip/height': { body: '1' } });
    const chain = new MempoolChainAdapter({
      network: 'signet', baseUrl: 'https://my-node.example/api/', fetchImpl: impl,
    });
    await chain.getTipHeight();
    expect(calls[0]).toBe('GET https://my-node.example/api/blocks/tip/height');
  });
});
