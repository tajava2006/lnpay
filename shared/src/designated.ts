/**
 * 지정 거래 — 상대(후원자)를 pubkey로 묶은, 보증금 없는 1:1 거래 (docs/PROTOCOL.md §2)
 *
 * ── 왜
 *
 * 신원 없는 공개 오더북에서 트롤을 막는 길은 보증금뿐인데, 보증금(홀드 인보이스)은 지갑을 가린다. 다른 곳에서 이미
 * 합의한 두 사람은 그게 필요 없다 — **상대를 묶으면** 트롤은 손을 댈 수 없고 남는 위험은 "내가 고른 상대" 하나다.
 *
 * ── 어떻게 보이나 (스냅샷)
 *
 * 지정 오더는 공개 오더(`ORDER_KIND`)로 내지 않는다. 데몬이 **수신자마다**(고객 · 지정 후원자 · 운영자) 주소형
 * `DESIGNATED_ORDER_KIND` 이벤트를 하나씩 내고, 내용은 공개 오더와 **같은 태그 배열**을 그 수신자에게 NIP-44로
 * 봉한 것이다. 받는 쪽은 열어서 **가짜 오더 이벤트**로 바꿔 기존 처리기에 그대로 넘긴다 — 파서·저장소·보관·되살리기가
 * 손대지 않고 돈다. 그래서 이 모듈은 봉하고 여는 것만 한다.
 *
 * 보이는 것: 지정 요청을 보낸 pubkey와 시각, APP이 어느 pubkey들에게 스냅샷을 보냈는지(`p`)와 시각. 숨는 것: 금액·
 * 기한·상대 지정·상태 전부.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import type { Event, EventTemplate } from 'nostr-tools/core';
import { decode, npubEncode } from 'nostr-tools/nip19';
import { APP_PUBKEY, ORDER_KIND } from './constants';
import { nip44Decrypt, nip44Encrypt } from './crypto';
import { isXonlyHex } from './onchain/hex';
import { arrayOf, isNum, isStr, optional, shape } from './shape';

/** 지정 오더 스냅샷 — 주소형, 우리 전용 kind (APP → 수신자 하나) */
export const DESIGNATED_ORDER_KIND = 33839;

/**
 * 고객 키 하나가 **수락을 기다리는** 지정 의뢰를 트랙마다 몇 개까지 띄울 수 있나. 지정 의뢰는 보증금이 없어 공짜라
 * 키 하나로 특정 후원자·운영자에게 의뢰를 쏟아붓는 걸 여기서 끊는다(RISKS R-16). 합의 거래는 보통 한 번에 하나다.
 */
export const MAX_OPEN_DESIGNATED_PER_CUSTOMER = 3;

/**
 * nostr pubkey인가 — x-only 형식(`isXonlyHex`) **이고 secp256k1 곡선 위의 점**이다.
 *
 * 형식만 보면 txid·이벤트 id·payment hash도 통과하는데 그 절반쯤은 곡선 밖이다 — NIP-44 대화 키가 `bad point`로 터진다.
 * 64자 검사만 하던 때 그런 값을 지정한 오더는 발행이 영원히 재시도에 갇혔다(2026-10-18 리뷰). 온체인 에스크로 키
 * 검사(`isXonlyHex`)는 서명 경로라 여기서 같이 조이지 않는다.
 */
export function isPubkeyHex(v: unknown): v is string {
  return typeof v === 'string' && isPubkey(v);
}

/** 가드가 아닌 판정 — 이미 string인 값에 가드를 쓰면 거짓 쪽이 `never`로 좁혀진다 */
function isPubkey(hex: string): boolean {
  if (!isXonlyHex(hex)) return false;
  try {
    schnorr.utils.lift_x(BigInt(`0x${hex}`));
    return true;
  } catch {
    return false;
  }
}

/** 스냅샷의 `d` — 오더 하나에 수신자마다 하나 */
export function designatedOrderD(orderId: string, recipient: string): string {
  return `${orderId}:${recipient}`;
}

/**
 * 수신자 하나에게 보낼 스냅샷 (데몬). `tags`는 공개 오더와 같은 배열(`lnOrderTags`·`onchainOrderTags`)이다.
 * `trackTag`는 구독 필터(`#t`)용 — 안의 `t` 태그와 같은 값이다.
 */
export function designatedOrderTemplate(p: {
  orderId: string;
  recipient: string;
  trackTag: string;
  tags: string[][];
  retainUntil: number;
  createdAt: number;
  appSecretKey: Uint8Array;
}): EventTemplate {
  return {
    kind: DESIGNATED_ORDER_KIND,
    created_at: p.createdAt,
    tags: [
      ['d', designatedOrderD(p.orderId, p.recipient)],
      ['p', p.recipient],
      ['t', p.trackTag],
      ['expiration', String(p.retainUntil)],
    ],
    content: nip44Encrypt(JSON.stringify(p.tags), p.appSecretKey, p.recipient),
  };
}

const isTagList = arrayOf(arrayOf(isStr));

/**
 * 받은 스냅샷의 평문 → **가짜 오더 이벤트**. 기존 오더 처리기에 그대로 넘긴다. 모양이 아니면 null.
 *
 * 평문을 받는 이유: 어드민은 NIP-46 서명기로 비동기 복호화한다(키를 안 든다). 앱은 `openDesignatedOrder`.
 */
export function designatedOrderFromPlaintext(event: Event, plaintext: string, appPubkey = APP_PUBKEY): Event | null {
  if (event.kind !== DESIGNATED_ORDER_KIND || event.pubkey !== appPubkey) return null;
  let tags: unknown;
  try {
    tags = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!isTagList(tags)) return null;
  // 서명은 바깥 이벤트의 것이라 여기 붙이지 않는다 — 가짜 이벤트를 다시 검증하는 곳은 없다
  return { kind: ORDER_KIND, pubkey: appPubkey, created_at: event.created_at, tags, content: '', id: event.id, sig: '' };
}

/** 앱 — 내 키로 연다. 내 것이 아니거나 망가졌으면 null */
export function openDesignatedOrder(event: Event, mySecretKey: Uint8Array, appPubkey = APP_PUBKEY): Event | null {
  if (event.kind !== DESIGNATED_ORDER_KIND || event.pubkey !== appPubkey) return null;
  try {
    return designatedOrderFromPlaintext(event, nip44Decrypt(event.content, mySecretKey, appPubkey), appPubkey);
  } catch {
    return null;
  }
}

// ── 요청 내용 (NIP-44, 고객 → APP) ──────────────────────────

/** 라이트닝 지정 의뢰 — 공개 의뢰의 `price`·`deadline` 태그가 여기로 들어간다 */
export interface LnDesignatedOrderPayload {
  price: number;
  deadline: number;
  designatedSponsor: string;
}

export const isLnDesignatedOrderPayload = shape<LnDesignatedOrderPayload>({
  price: isNum, deadline: isNum, designatedSponsor: isPubkeyHex,
});

/** 온체인 지정 의뢰 — 공개 의뢰의 `amount-sat`·`customer-xonly`·`reserve-krw` 태그와 환불 주소가 여기로 */
export interface OnchainDesignatedOrderPayload {
  amountSat: number;
  customerXonly: string;
  reserveKrw?: number;
  refundAddress: string;
  designatedSponsor: string;
}

export const isOnchainDesignatedOrderPayload = shape<OnchainDesignatedOrderPayload>({
  amountSat: isNum, customerXonly: isStr, reserveKrw: optional(isNum), refundAddress: isStr,
  designatedSponsor: isPubkeyHex,
});

// ── 주소 (공유해도 되는 값) ──────────────────────────────────

/** 내 주소 — npub. 비밀키(nsec)와 화면을 섞지 않는다 */
export function npubOf(pubkey: string): string {
  return npubEncode(pubkey);
}

/**
 * 확인 코드 — npub 본문 앞 6 · 뒤 6. 두 사람이 서로의 화면에서 같은지 본다(잘못 붙여넣은 주소로 남에게 무담보 의뢰가
 * 가는 걸 막는다). 일부러 맞춘 가짜 키를 만들려면 60비트를 맞춰야 한다.
 */
export function checkCode(pubkey: string): string {
  const body = npubEncode(pubkey).slice('npub1'.length);
  return `${body.slice(0, 6)}…${body.slice(-6)}`;
}

/**
 * 붙여넣은 주소 → pubkey hex. npub · nprofile · hex 64자 · `nostr:` 접두사를 받는다. 못 읽거나 **곡선 밖의 키**면 null.
 * nsec는 **받지 않는다** — 비밀키를 주소 칸에 붙여넣는 실수를 여기서 끊는다.
 *
 * bech32는 대문자도 맞는 표기다(QR 영숫자 모드가 대문자로 만든다) — 대소문자를 **섞은** 것만 틀렸다.
 */
export function parsePubkeyInput(text: string): string | null {
  const t = text.trim().replace(/^nostr:/i, '');
  if (t !== t.toLowerCase() && t !== t.toUpperCase()) return null;
  const lower = t.toLowerCase();
  if (isPubkey(lower)) return lower;
  if (!/^(npub1|nprofile1)/.test(lower)) return null;
  let pubkey: string | undefined;
  try {
    const d = decode(lower);
    if (d.type === 'npub') pubkey = d.data;
    else if (d.type === 'nprofile') pubkey = d.data.pubkey;
  } catch {
    return null;
  }
  return pubkey !== undefined && isPubkey(pubkey) ? pubkey : null;
}
