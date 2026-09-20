/**
 * 체인 어댑터 — mempool.space REST (PLAN-ONCHAIN-TRACK §11 P2)
 *
 * ⚠️ **어드민 전용이 아니다.** 후원자 앱도 체인을 봐야 한다 — 원화를 보내기 전
 * 타임락 잔여를 확인하고(§7.1 · T-106), 종결 tx가 막히면 CPFP를 해야 한다(§7 L).
 * 그래서 shared에 둔다(§8은 admin에 뒀는데, 그러면 같은 코드가 두 벌이 된다).
 *
 * ── 이 파일의 계약 (§4.1c)
 *
 * **펀딩 판정은 주소 기준이다.** "마감 안에, 이 주소로, 약정 금액이, N컨펌 됐는가"
 * 하나만 답하면 된다. 중간에 고객이 멤풀에 넣었다 뺐다 하든 RBF로 수수료를
 * 올리든 **우리 판정에 아무 영향이 없다.**
 *
 * txid를 쓰는 곳은 둘뿐이다:
 *   ① 종결 tx를 만들 때 — 그 UTXO를 소모해야 하므로 outpoint가 필요하다.
 *      **컨펌된 UTXO에서** 나온다
 *   ② 우리가 브로드캐스트한 종결 tx의 컨펌을 지켜볼 때 — 우리가 만든 txid다
 *
 * 즉 **남의 tx를 txid로 쫓는 코드는 여기 없다.** 고객이 수수료를 올리면 txid가
 * 바뀌는데, 그걸 "사라졌다"로 읽으면 정직한 고객의 보증금을 몰수하게 된다.
 *
 * ── 조회 실패는 '없음'이 아니라 '모름'이다
 *
 * `FundStatus`에서 겪은 사고가 이것이다 — 조회 실패를 '없음'으로 뭉개면
 * "돈이 없다"로 읽혀 위험한 판단을 부른다. 그래서 모든 조회가 `ChainQuery<T>`를
 * 돌려준다. `known: false`를 안 보고는 값을 꺼낼 수 없으므로, **'모름'을 '없음'으로
 * 쓰는 코드를 타입으로 못 쓰게** 만든 것이다.
 */

import type { Outpoint } from './tx';

// ─── 결과 타입 ───────────────────────────────────────────────

/**
 * 체인 조회 결과. **`known: false`는 "없다"가 아니라 "모른다"** 다.
 *
 * 네트워크 실패·타임아웃·파싱 실패가 전부 여기로 온다. 호출부는 이걸
 * 값으로 받아 "아직 모르니 아무것도 하지 않는다"를 선택해야 한다.
 */
export type ChainQuery<T> =
  | { known: true; value: T }
  | { known: false; reason: string };

/**
 * outpoint 정의는 **shared가 진실**이다 — 종결 tx 빌더가 같은 모양을 먹는다.
 * 여기서 따로 정의하면 둘이 갈릴 자리가 생긴다.
 */
export type ChainOutpoint = Outpoint;

export interface ChainUtxo extends ChainOutpoint {
  valueSat: number;
  /** 컨펌 수. 멤풀이면 0 */
  confirmations: number;
}

/**
 * 한 주소의 자금 현황.
 *
 * ⚠️ `mempool`은 **화면 힌트 전용**이다("멤풀에서 보임 · 컨펌 대기").
 * 어떤 판정에도 쓰지 않는다 — 0-conf는 되돌려질 수 있고(공격 D), 그래서
 * FSM에 `funding` 상태를 두지 않았다(§4.1c).
 */
export interface AddressFunds {
  confirmed: ChainUtxo[];
  mempool: ChainUtxo[];
}

export interface TxStatus {
  confirmed: boolean;
  confirmations: number;
  blockHeight?: number;
}

/** mempool.space `/api/v1/fees/recommended` (sat/vB) */
export interface FeeEstimates {
  fastest: number;
  halfHour: number;
  hour: number;
  economy: number;
  minimum: number;
}

export interface ChainAdapter {
  /** 이 주소에 들어온 자금 (컨펌 / 멤풀 분리) */
  getAddressFunds(address: string): Promise<ChainQuery<AddressFunds>>;
  /** 우리가 브로드캐스트한 tx의 컨펌 상태 */
  getTxStatus(txid: string): Promise<ChainQuery<TxStatus>>;
  getFeeEstimates(): Promise<ChainQuery<FeeEstimates>>;
  getTipHeight(): Promise<ChainQuery<number>>;
  /** 서명 완료된 raw tx를 뿌린다. 성공하면 txid */
  broadcastTx(rawHex: string): Promise<ChainQuery<string>>;
}

// ─── 네트워크 ────────────────────────────────────────────────

export type ChainNetwork = 'mainnet' | 'signet' | 'testnet';

/**
 * 기본 엔드포인트. **바꿀 수 있게 열어둔다** — 공개 인스턴스가 우리 IP를 차단한
 * 적이 있고(2026-09-04 arkade), 자체 인스턴스를 띄울 수도 있다.
 */
export const DEFAULT_MEMPOOL_API: Record<ChainNetwork, string> = {
  mainnet: 'https://mempool.space/api',
  signet: 'https://mempool.space/signet/api',
  testnet: 'https://mempool.space/testnet/api',
};

export interface ChainAdapterConfig {
  network: ChainNetwork;
  /** 미지정 시 `DEFAULT_MEMPOOL_API[network]` */
  baseUrl?: string;
  /** 요청 타임아웃(ms). 기본 10초 — 넘으면 '모름'이다 */
  timeoutMs?: number;
  /** 테스트에서 주입한다 */
  fetchImpl?: typeof fetch;
}

// ─── mempool.space 응답 (쓰는 필드만) ────────────────────────

interface MempoolUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

interface MempoolTx {
  status: { confirmed: boolean; block_height?: number };
}

interface MempoolFees {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

// ─── 구현 ────────────────────────────────────────────────────

export class MempoolChainAdapter implements ChainAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(config: ChainAdapterConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_MEMPOOL_API[config.network]).replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.doFetch = config.fetchImpl ?? ((...args) => fetch(...args));
  }

  /**
   * 한 번 시도하고 실패는 전부 '모름'으로 바꾼다.
   *
   * 재시도는 여기서 하지 않는다 — 워처가 주기적으로 다시 부르므로(P4) 여기서
   * 또 돌면 실패가 느리게 드러나기만 한다. 빨리 '모름'을 말하는 쪽이 낫다.
   */
  private async request<T>(path: string, init?: RequestInit): Promise<ChainQuery<T | string>> {
    try {
      const res = await this.doFetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        return { known: false, reason: `${path} → ${res.status} ${text.slice(0, 200)}` };
      }
      // mempool.space는 엔드포인트에 따라 JSON과 평문을 섞어 돌려준다
      // (tip height·broadcast는 평문). 호출부가 모양을 안다.
      try {
        return { known: true, value: JSON.parse(text) as T };
      } catch {
        return { known: true, value: text.trim() };
      }
    } catch (e) {
      return { known: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async getAddressFunds(address: string): Promise<ChainQuery<AddressFunds>> {
    // 컨펌 수를 세려면 팁 높이가 필요하다. **둘 중 하나라도 실패하면 '모름'이다** —
    // UTXO만 받고 컨펌 수를 0으로 뭉개면 "아직 안 됐다"는 거짓말이 된다.
    const [utxoRes, tipRes] = await Promise.all([
      this.request<MempoolUtxo[]>(`/address/${address}/utxo`),
      this.getTipHeight(),
    ]);

    if (!utxoRes.known) return utxoRes;
    if (!tipRes.known) return tipRes;
    if (!Array.isArray(utxoRes.value)) {
      return { known: false, reason: 'UTXO 응답이 배열이 아니다' };
    }

    const tip = tipRes.value;
    const confirmed: ChainUtxo[] = [];
    const mempool: ChainUtxo[] = [];

    for (const u of utxoRes.value as MempoolUtxo[]) {
      if (typeof u?.txid !== 'string' || typeof u?.vout !== 'number' || typeof u?.value !== 'number') {
        return { known: false, reason: 'UTXO 응답에 모르는 모양이 섞여 있다' };
      }
      const height = u.status?.block_height;
      const isConfirmed = u.status?.confirmed === true && typeof height === 'number';
      const utxo: ChainUtxo = {
        txid: u.txid,
        vout: u.vout,
        valueSat: u.value,
        confirmations: isConfirmed ? Math.max(0, tip - height! + 1) : 0,
      };
      (isConfirmed ? confirmed : mempool).push(utxo);
    }

    return { known: true, value: { confirmed, mempool } };
  }

  async getTxStatus(txid: string): Promise<ChainQuery<TxStatus>> {
    const [txRes, tipRes] = await Promise.all([
      this.request<MempoolTx>(`/tx/${txid}`),
      this.getTipHeight(),
    ]);
    if (!txRes.known) return txRes;
    if (!tipRes.known) return tipRes;

    const status = (txRes.value as MempoolTx)?.status;
    if (typeof status?.confirmed !== 'boolean') {
      return { known: false, reason: 'tx 응답에 status가 없다' };
    }
    if (!status.confirmed) {
      return { known: true, value: { confirmed: false, confirmations: 0 } };
    }
    const height = status.block_height;
    if (typeof height !== 'number') {
      return { known: false, reason: 'confirmed인데 block_height가 없다' };
    }
    return {
      known: true,
      value: {
        confirmed: true,
        confirmations: Math.max(0, tipRes.value - height + 1),
        blockHeight: height,
      },
    };
  }

  async getFeeEstimates(): Promise<ChainQuery<FeeEstimates>> {
    const res = await this.request<MempoolFees>('/v1/fees/recommended');
    if (!res.known) return res;
    const f = res.value as MempoolFees;
    const nums = [f?.fastestFee, f?.halfHourFee, f?.hourFee, f?.economyFee, f?.minimumFee];
    if (nums.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) {
      return { known: false, reason: '수수료 응답이 비정상이다' };
    }
    return {
      known: true,
      value: {
        fastest: f.fastestFee,
        halfHour: f.halfHourFee,
        hour: f.hourFee,
        economy: f.economyFee,
        minimum: f.minimumFee,
      },
    };
  }

  async getTipHeight(): Promise<ChainQuery<number>> {
    const res = await this.request<number>('/blocks/tip/height');
    if (!res.known) return res;
    const height = Number(res.value);
    if (!Number.isInteger(height) || height <= 0) {
      return { known: false, reason: `팁 높이가 비정상이다: ${String(res.value).slice(0, 40)}` };
    }
    return { known: true, value: height };
  }

  async broadcastTx(rawHex: string): Promise<ChainQuery<string>> {
    if (!/^[0-9a-fA-F]+$/.test(rawHex) || rawHex.length % 2 !== 0) {
      return { known: false, reason: 'raw tx가 16진 문자열이 아니다' };
    }
    const res = await this.request<string>('/tx', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: rawHex,
    });
    if (!res.known) return res;
    const txid = String(res.value).trim();
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      return { known: false, reason: `브로드캐스트 응답이 txid가 아니다: ${txid.slice(0, 120)}` };
    }
    return { known: true, value: txid };
  }
}
