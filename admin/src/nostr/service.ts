/**
 * 어드민 Nostr 구독 서비스
 *
 * 요청(kind 1111)과 오더(kind 30402)를 구독하여
 * 각각 request-store, order-store에 반영한다.
 *
 * action별 자동 처리:
 * - order-request: 오더 생성 + kind 30402 발행
 * - claim: 오더 상태 전이 (requested → claimed) + kind 30402 갱신
 * - payment-confirm: Customer 입금 컨펌 → paid 전이 + kind 30402 갱신
 * - cancel-request: Customer 취소 요청 → cancelled 전이 + kind 30402 갱신
 *
 * Admin UI 트리거:
 * - approveOrder: 클레임 승인 (claimed → verified) + kind 30402 갱신
 * - revertClaim: 클레임 철회 (claimed → requested) + kind 30402 갱신
 */
import {
  getReadRelays,
  APP_PUBKEY,
  idbUpsertOrder,
  idbGetOrder,
  idbUpsertRequest,
  idbGetRequestsByOrderId,
  idbMigrateOrderWithRequests,
  processDisputeEvent,
  createSubscriptionGuard,
  createSingleFlight,
  type Order,
  type Request,
  type OrderRequest,
  type ClaimRequest,
  type SponsorInvoiceRequest,
  type PriceTracker,
  storage,
} from '@sajwo-tracker/shared';
import { subscribeAdmin } from './subscribe';
import { publishOrder, publishInvoiceRejected, publishDepositRequired } from './publish';
import { notifyTransition, notifyAccountInfoArrived } from './notify-triggers';
import { saveSubscription } from '../web-push/store';
import { sendPushToDevice } from '../web-push/send';
import { PUSH_WELCOME } from './notify-messages';
import { isPushSubscriptionPayload } from '../web-push/types';
import { claimNotification } from '../notified-events';
import { getSigner } from './nip46';
import { parseRequestEvent, parseOrderEvent, decodeBolt11 } from '../types';
import { upsertRequest, markSynced } from '../request-store';
import { upsertOrder, getOrder } from '../order-store';
import {
  canTransition, computePayoutSat, computeEscrowSat, isPayoutAmountExact,
} from '../state-machine';
import type { LightningAdapter } from '../lightning';
import { getPreimage, getEscrowEntry } from '../escrow-store';
import { getCustomerDepositPercent, getSponsorDepositPercent } from '../deposit-config';
import { savePendingDeposit, getPendingDeposit } from '../pending-deposit-store';
import { handleDepositOnTransition } from '../deposit-lifecycle';
import { escrowInvoiceExpiry, escrowDeadline } from '../escrow-window';

/**
 * 에스크로 만료가 이만큼 남지 않았으면 새 약속을 받지 않는다.
 * invoice-watcher의 선제 settle 마진과 같은 값이어야 한다 — 다르면 한쪽이
 * "아직 괜찮다"고 받아들인 걸 다른 쪽이 "이미 늦었다"고 처리한다.
 */
const SETTLE_SAFETY_MARGIN_SEC = 10 * 60;

/**
 * 후원자 인보이스에 요구하는 최소 잔여 수명.
 *
 * 제출(escrowed)부터 지급(paid)까지 계좌 전달 + 원화 이체 + 고객 컨펌이 들어간다.
 * 은행 영업시간을 넘기면 하루도 간다. 6시간은 "그 안에 대부분 끝난다"가 아니라
 * **지갑 기본값(흔히 1시간)을 거르되 너무 빡세지 않은 선**이다. 그래도 만료되는
 * 건 재제출로 받는다.
 */
const MIN_INVOICE_LIFETIME_SEC = 6 * 60 * 60;

const guard = createSubscriptionGuard('Admin');
let lnAdapterRef: LightningAdapter | null = null;
let priceTrackerRef: PriceTracker | null = null;

/** LN 어댑터 참조를 설정한다. App 마운트 시 호출. */
export function setLnAdapter(adapter: LightningAdapter | null): void {
  lnAdapterRef = adapter;
}

/** PriceTracker 참조를 설정한다. App 마운트 시 호출. */
export function setPriceTracker(tracker: PriceTracker | null): void {
  priceTrackerRef = tracker;
}

export function startAdminSubscription(): Promise<void> {
  return guard.start(async () => {
    const relays = await getReadRelays(storage);

    // EOSE까지 리퀘스트를 버퍼링하여 catch-up 중 stale 상태 기반 처리를 방지한다.
    // 오더 에코가 먼저 로컬에 반영된 후 버퍼의 리퀘스트를 처리하면
    // canTransition이 과거 리퀘스트를 정확히 거부한다.
    let pendingRequests: Request[] | null = [];

    return subscribeAdmin(relays, {
      onRequest: (event) => {
        const request = parseRequestEvent(event);
        if (!request) return;

        // dispute-message는 messages IDB에만 저장 (requests 스토어 skip)
        if (request.action === 'dispute-message') {
          void handleDisputeMessage(request);
          return;
        }

        // 구독 등록은 오더 요청이 아니다 — orderId가 없으므로 requests 스토어에
        // 넣으면 빈 키로 오염된다. 바로 처리하고 끝낸다.
        if (request.action === 'push-subscription') {
          void handlePushSubscription(request);
          return;
        }

        upsertRequest(request);
        void syncRequestToIdb(request);

        // catch-up 중이면 버퍼에 쌓고, EOSE 이후에 처리
        if (pendingRequests) {
          pendingRequests.push(request);
          return;
        }

        dispatchRequest(request);
      },
      onOrder: (event) => {
        const order = parseOrderEvent(event);
        if (order) {
          upsertOrder(order);
          void syncOrderToIdb(order);
        }
      },
      onEose: () => {
        markSynced();
        // 오더 상태가 최신으로 반영된 후 버퍼의 리퀘스트를 순차 처리
        const buffered = pendingRequests;
        pendingRequests = null;
        if (buffered) {
          for (const req of buffered) {
            dispatchRequest(req);
          }
        }
      },
    });
  });
}

/** 리퀘스트를 action별 핸들러에 분배한다. */
function dispatchRequest(request: Request): void {
  if (request.action === 'order-request') {
    void handleOrderRequest(request);
  } else if (request.action === 'claim') {
    void handleClaim(request);
  } else if (request.action === 'payment-confirm') {
    void handlePaymentConfirm(request);
  } else if (request.action === 'cancel-request') {
    void handleCancelRequest(request);
  } else if (request.action === 'account-info') {
    handleAccountInfo(request);
  } else if (request.action === 'remit-request') {
    void handleRemitRequest(request);
  } else if (request.action === 'sponsor-invoice') {
    void handleSponsorInvoice(request);
  }
}

/**
 * 후원자가 지급받을 인보이스를 제출했다 → `escrowed → invoiced`.
 *
 * **이 전이가 계좌 정보의 관문이다.** 고객 앱은 `invoiced` 이전에는 계좌를
 * 발행하지 않으므로, 여기를 통과하지 못하면 후원자는 원화를 보낼 수 없다.
 * 후원자 보호가 목적이다 — 되돌릴 수 없는 이체 직전에 "받을 준비가 됐는가"를
 * 확인시킨다. 근거 = docs/DESIGN-LATE-INVOICE.md
 *
 * 검증 네 가지. 하나라도 어긋나면 저장하지 않는다(불변조건 I-011).
 */
async function handleSponsorInvoice(request: SponsorInvoiceRequest): Promise<void> {
  const order = getOrder(request.orderId);
  if (!order) return;

  // ① 소유자 — 남이 남의 오더에 지급처를 꽂지 못하게. remit-request와 같은 패턴.
  if (order.sponsorPubkey !== request.pubkey) {
    console.warn('[Admin] sponsor-invoice pubkey mismatch for', request.orderId);
    return;
  }

  // ② 순서 — escrowed에서만 받는다. 에스크로 전에 받아주면 계좌 관문이
  //    앞당겨져 "돈은 안 잠겼는데 계좌가 나가는" 창이 생긴다.
  //    invoiced에서의 재제출은 아래에서 따로 허용한다(만료 교체).
  const isReplacement = order.state === 'invoiced';
  if (!isReplacement && !canTransition(order.state, 'invoiced')) {
    console.warn('[Admin] Cannot accept sponsor-invoice for', request.orderId, '- state:', order.state);
    return;
  }

  const decoded = decodeBolt11(request.bolt11);
  if (!decoded) {
    console.warn('[Admin] sponsor-invoice decode failed for', request.orderId);
    void publishInvoiceRejected(request.orderId, request.pubkey, 'DECODE_FAILED').catch(() => {});
    return;
  }

  // ③ 금액 — 범위가 아니라 **정확 일치**. 금액을 정한 게 우리라 근사할 이유가 없다.
  if (!isPayoutAmountExact(order.payoutSat, decoded.amountSat)) {
    console.warn(
      '[Admin] sponsor-invoice amount mismatch for %s (expected %d, got %d)',
      request.orderId, order.payoutSat ?? 0, decoded.amountSat,
    );
    void publishInvoiceRejected(request.orderId, request.pubkey, 'AMOUNT_MISMATCH', order.payoutSat ?? 0).catch(() => {});
    return;
  }

  // ④ 만료 — 제출 시점에 최소 수명을 요구한다. 지급은 계좌 전달 + 원화 이체 +
  //    컨펌 뒤라 몇 시간 뒤다. 그래도 만료될 수 있어 재제출을 열어두지만,
  //    하한이 없으면 그 빈도가 감당이 안 된다.
  const now = Math.floor(Date.now() / 1000);
  if (decoded.expiresAt > 0 && decoded.expiresAt - now < MIN_INVOICE_LIFETIME_SEC) {
    console.warn('[Admin] sponsor-invoice expires too soon for', request.orderId);
    void publishInvoiceRejected(request.orderId, request.pubkey, 'EXPIRES_TOO_SOON').catch(() => {});
    return;
  }

  // 에스크로가 먼저 죽으면 후원자가 원화를 보낸 뒤 HTLC가 타임아웃으로 환불된다
  // — 후원자만 잃는 최악의 결말이다. 인보이스 수명 하한(6h)만 보면 에스크로가
  // 2시간 남았을 때 6시간짜리를 내도 통과해버린다. 남은 에스크로 시간도 본다.
  const entry = getEscrowEntry(request.orderId);
  if (entry) {
    const escrowLeft = escrowDeadline(order.expiration, entry.createdAt) - now;
    if (escrowLeft <= SETTLE_SAFETY_MARGIN_SEC) {
      console.warn('[Admin] 에스크로가 곧 만료 — 인보이스를 받지 않는다:', request.orderId, escrowLeft, 's');
      void publishInvoiceRejected(request.orderId, request.pubkey, 'ESCROW_ENDING_SOON').catch(() => {});
      return;
    }
  }

  // ⑤ 유동성 프로빙 — 원화 이체 직전에 여기서 한다.
  //
  // 예전에는 claimed → verified를 막고 있었다. 그러면 후원자 노드 사정으로
  // 고객이 에스크로조차 못 걸었는데, 정작 유동성 부족으로 손해 보는 건 후원자다.
  // 이 자리로 옮기면 고객의 진행을 막지 않으면서 **후원자가 원화를 보내기 전에**
  // "정말 받을 수 있는가"를 확인시킨다. 그게 프로빙의 원래 목적이다.
  //
  // 실패해도 막지는 않는다. 프로빙은 경로 추정일 뿐이고 소액에서는 오탐도 난다.
  // 유저 책임 범위를 인프라가 떠안지 않는다 — 대신 결과를 알려준다.
  let liquidityOk: boolean | null = null;
  if (lnAdapterRef) {
    try {
      const probe = await lnAdapterRef.probe(
        decoded.destination,
        decoded.amountSat,
        undefined,
        decoded.routeHints.length > 0 ? decoded.routeHints : undefined,
      );
      liquidityOk = probe.status === 'reachable';
      if (!liquidityOk) {
        console.warn('[Admin] 인보이스 유동성 프로빙 실패(차단은 안 함):', request.orderId, probe.status);
        void publishInvoiceRejected(request.orderId, request.pubkey, 'LIQUIDITY_WARNING', order.payoutSat ?? 0)
          .catch(() => {});
      }
    } catch (e) {
      console.warn('[Admin] 프로빙 요청 실패 — 판단 보류:', request.orderId, e);
    }
  }

  const updatedOrder: Order = {
    ...order,
    state: 'invoiced',
    sponsorInvoice: request.bolt11,
    updatedAt: now,
  };

  try {
    await publishOrder(updatedOrder);
    console.log(
      '[Admin] Order', request.orderId,
      isReplacement ? 'sponsor invoice replaced' : 'invoiced (sponsor invoice accepted)',
      liquidityOk === null ? '(프로빙 미실시)' : liquidityOk ? '(유동성 OK)' : '(유동성 경고)',
    );
    // 교체는 이미 invoiced라 상태가 안 바뀐다 — 알림도 보내지 않는다.
    if (!isReplacement) notifyTransition(updatedOrder);
  } catch (e) {
    console.error('[Admin] Failed to publish invoiced order for', request.orderId, e);
  }
}

/**
 * Web Push 구독 등록을 받아 저장한다.
 *
 * 내용은 유저가 어드민에게만 열리게 NIP-44로 암호화했다 — 엔드포인트와 인증
 * 시크릿이 공개되면 아무나 그 유저에게 푸시를 쏠 수 있다.
 *
 * 주문에 묶이지 않는 계정 단위 등록이라 오더 조회나 상태 검증이 없다.
 * 이벤트 서명이 곧 "이 pubkey 본인이 등록했다"는 증명이므로 그걸로 충분하다.
 */
async function handlePushSubscription(request: Request): Promise<void> {
  const signer = getSigner();
  if (!signer) return;

  const event = request.raw as { content?: string };
  if (!event.content) return;

  try {
    const plaintext = await signer.nip44Decrypt(request.pubkey, event.content);
    const parsed: unknown = JSON.parse(plaintext);
    if (!isPushSubscriptionPayload(parsed)) {
      console.warn('[Push] 구독 형식이 아님:', request.pubkey.slice(0, 8));
      return;
    }
    // 처음 보는 기기일 때만, 그리고 **그 기기에만** 환영 알림을 보낸다.
    //
    // 어드민을 새로고침할 때마다 같은 등록 이벤트가 릴레이에서 다시 오므로
    // "처음 보는가" 판정이 필요하고, 전체 발송을 쓰면 그 사람의 멀쩡한 다른
    // 기기까지 매번 울린다 — 둘 다 실제로 겪은 문제다.
    if (saveSubscription(request.pubkey, parsed)) {
      void sendPushToDevice(request.pubkey, parsed, PUSH_WELCOME);
    }
  } catch (e) {
    console.warn('[Push] 구독 등록 처리 실패:', request.pubkey.slice(0, 8), e);
  }
}

export function stopAdminSubscription(): void {
  guard.stop();
}

// ============================================================
// Admin UI Actions
// ============================================================

/**
 * 클레임을 승인하여 claimed → verified로 전이하고 kind 30402를 발행한다.
 * hold invoice를 생성하여 오더에 첨부한다. 프리이미지는 NIP-44 암호화 저장 + 릴레이 백업된다.
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
export async function approveOrder(
  orderId: string,
  lnAdapter: LightningAdapter,
): Promise<{ success: boolean; error?: string }> {
  const order = getOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (!canTransition(order.state, 'verified')) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → verified` };
  }

  // ── 금액 확정 ──
  //
  // 여기가 **금액이 정해지는 유일한 지점**이다. 후원자가 받을 payout을 시세로
  // 정하고 고객이 낼 에스크로를 거기서 파생한다. 이후 아무도 못 바꾼다.
  // 시세를 못 읽으면 조용히 넘어가지 않고 명시적으로 실패한다 — 값이 틀리면
  // 돈이 틀리기 때문이다.
  const btcPrice = priceTrackerRef?.getSnapshot().price;
  const payoutSat = btcPrice ? computePayoutSat(order.price, btcPrice) : null;
  if (!payoutSat) {
    return { success: false, error: 'NO_PRICE_FEED' };
  }
  const amountSat = computeEscrowSat(payoutSat);

  // 홀드 인보이스 수명은 **의뢰 수명과 분리**한다. 근거 = escrow-window.ts
  // 장기 의뢰(후원자를 몇 주씩 기다리는 경우)에 의뢰 만료를 그대로 쓰면
  // CLTV가 채널 상한(보통 2016블록)을 넘어 인보이스 자체가 못 만들어진다.
  const now = Math.floor(Date.now() / 1000);
  const expiry = escrowInvoiceExpiry(order.expiration, now);
  if (expiry <= 0) {
    return { success: false, error: 'ORDER_EXPIRED' };
  }

  // CLTV 타임아웃 = 오더 만료까지 남은 시간 + 48시간 (분쟁 판정 여유)
  // 오더 만료 후에도 Admin이 settle/cancel할 시간을 확보한다.
  // 10분/블록 기준으로 초 → 블록 수 변환 (올림)
  const DISPUTE_MARGIN_SECONDS = 48 * 60 * 60;
  const cltvExpiry = Math.ceil((expiry + DISPUTE_MARGIN_SECONDS) / 600);

  // hold invoice 생성 (프리이미지는 LN 어댑터 내부에서 NIP-44 암호화 저장 + 릴레이 백업)
  let bolt11: string;
  try {
    const result = await lnAdapter.createHoldInvoice(orderId, amountSat, expiry, cltvExpiry);
    bolt11 = result.bolt11;
    console.log('[Admin] Hold invoice created for', orderId, '- paymentHash:', result.paymentHash);
  } catch (e) {
    console.error('[Admin] Failed to create hold invoice for', orderId, e);
    return { success: false, error: 'HOLD_INVOICE_FAILED' };
  }

  const updatedOrder: Order = {
    ...order,
    state: 'verified',
    bolt11,
    payoutSat,
    updatedAt: now,
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', orderId, 'approved (claimed → verified)');
    notifyTransition(updatedOrder);
  } catch (e) {
    console.error('[Admin] Failed to publish verified order for', orderId, e);
    return { success: false, error: 'PUBLISH_FAILED' };
  }

  return { success: true };
}

/**
 * 방치된 거래를 어드민이 강제 종결한다 (`escrowed`/`invoiced` → `admin_closed`).
 *
 * ── 왜 필요한가
 *
 * 에스크로가 잡힌 뒤 아무도 움직이지 않으면 홀드 인보이스가 CLTV 타임아웃까지
 * 유동성을 붙들고 있는다. 그 채널로 나가는 **다른 결제까지 막는다** —
 * 2026-09-19에 CLN askrene이 채널을 통째로 막아 다른 의뢰 결제가 실패했다.
 * 그때는 `lncli cancelinvoice`로 손으로 내려가야 했다.
 *
 * ── 에스크로를 취소(환불)한다
 *
 * settle이 아니라 cancel이다. 원화가 오갔다는 주장조차 없는 상태이므로 고객
 * 돈을 가져갈 근거가 없다. 원화가 실제로 오갔다면 그건 분쟁이고
 * `sponsor_wins`/`customer_wins`로 가야 한다.
 *
 * ⚠️ `invoiced`에서 부르면 계좌가 이미 나간 뒤다. 후원자가 송금해놓고 버튼만
 * 안 눌렀을 수 있다. 그건 후원자의 불성실이지만 돈은 진짜로 나갔을 수 있으므로,
 * **호출자가 경고를 띄우고 어드민이 판단**한다. 코드가 대신 막지는 않는다.
 */
export async function forceCloseOrder(
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
  // 라이브 스토어에 없으면 IDB를 본다.
  //
  // cleanup이 만료된 오더를 스토어에서 지우는데(보존은 IDB 몫), **만료된 의뢰야말로
  // 정리가 제일 필요한 것**이다 — 방치돼서 만료된 것이니까. 스토어만 보면
  // 정리해야 할 대상이 정확히 정리 불가능해진다.
  const order = getOrder(orderId) ?? await idbGetOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (!canTransition(order.state, 'admin_closed')) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → admin_closed` };
  }

  // 홀드 인보이스를 먼저 취소한다. 상태만 바꾸고 인보이스를 남기면 정리하려던
  // 유동성이 그대로 묶인 채 화면만 깨끗해진다 — 제일 나쁜 결과다.
  const entry = getEscrowEntry(orderId);
  if (entry && lnAdapterRef) {
    try {
      const status = await lnAdapterRef.lookupHoldInvoice(entry.paymentHash);
      if (status === 'settled') {
        // 이미 정산됐다면 BTC는 어드민에게 있다. 환불은 별도 결제로 해야 하므로
        // 자동으로 종결하지 않는다 — 조용히 닫으면 고객 돈이 증발한 것처럼 된다.
        return { success: false, error: 'ALREADY_SETTLED' };
      }
      if (status === 'accepted' || status === 'open') {
        await lnAdapterRef.cancelInvoice(entry.paymentHash);
        console.log('[Admin] 강제 종결 — 에스크로 취소:', orderId);
      }
    } catch (e) {
      console.error('[Admin] 강제 종결 중 에스크로 취소 실패:', orderId, e);
      return { success: false, error: 'CANCEL_FAILED' };
    }
  }

  const updatedOrder: Order = {
    ...order,
    state: 'admin_closed',
    status: 'sold',
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', orderId, 'force-closed by admin');
    notifyTransition(updatedOrder);
  } catch (e) {
    console.error('[Admin] Failed to publish admin_closed for', orderId, e);
    return { success: false, error: 'PUBLISH_FAILED' };
  }

  // 보증금은 양쪽 다 환불한다. 후원자가 방치한 건 맞지만 몰수는 별도 판단이고,
  // 자동으로 남의 돈을 가져가는 기본값을 두지 않는다.
  void handleDepositOnTransition(updatedOrder, 'admin_closed', lnAdapterRef).catch(err =>
    console.warn('[Admin] Deposit lifecycle failed on admin_closed:', orderId, err),
  );

  return { success: true };
}

/**
 * 유동성 검증 실패 등으로 클레임을 철회하여 claimed → requested로 되돌린다.
 * sponsorPubkey를 제거하여 다른 후원자가 클레임할 수 있도록 한다.
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
export async function revertClaim(
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
  const order = getOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (!canTransition(order.state, 'requested')) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → requested` };
  }

  const updatedOrder: Order = {
    ...order,
    state: 'requested',
    sponsorPubkey: undefined,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', orderId, 'reverted to requested (claim withdrawn)');
  } catch (e) {
    console.error('[Admin] Failed to publish reverted order for', orderId, e);
    return { success: false, error: 'PUBLISH_FAILED' };
  }

  return { success: true };
}

/**
 * Sponsor에게 BTC를 송금한다.
 * paid 또는 sponsor_wins 상태에서 호출 가능.
 * IDB에서 해당 Sponsor의 claim request를 조회하여 원본 bolt11로 결제한다.
 * 성공 시 order에 disbursed: true를 기록하여 중복 송금을 방지한다.
 */
export async function disburseSponsor(
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
  const order = getOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (order.state !== 'paid' && order.state !== 'sponsor_wins') {
    return { success: false, error: `INVALID_STATE: ${order.state}` };
  }
  if (order.disbursed) {
    return { success: false, error: 'ALREADY_DISBURSED' };
  }
  if (!order.sponsorPubkey) {
    return { success: false, error: 'NO_SPONSOR_PUBKEY' };
  }
  if (!lnAdapterRef) {
    return { success: false, error: 'NO_LN_ADAPTER' };
  }

  // `disbursed` 검사와 기록 사이에 LN 결제 await이 통째로 들어간다. 버튼 더블클릭이나
  // invoice-watcher와 겹치면 두 호출이 모두 위 검사를 통과해 결제를 시도할 수 있다.
  // 지금까지 이중 지급이 안 난 건 LND가 payment hash로 중복을 걸러줬기 때문이지
  // 이 코드가 막아서가 아니었다(감사 2026-09-13 A-2). 우리 쪽에서 먼저 닫는다.
  const adapter = lnAdapterRef;
  return disbursing.run(
    orderId,
    () => runDisbursement(orderId, order, adapter),
    () => ({ success: false, error: 'DISBURSEMENT_IN_FLIGHT' }),
  );
}

/** 진행 중인 지급. 같은 오더로 두 번 들어오면 두 번째를 거절한다. */
const disbursing = createSingleFlight();

/** 어댑터는 인자로 받는다 — 모듈 참조를 다시 읽으면 위에서 한 null 체크가 무의미해진다. */
async function runDisbursement(
  orderId: string,
  order: Order,
  lnAdapter: LightningAdapter,
): Promise<{ success: boolean; error?: string }> {

  // 지급처는 오더에 박혀 있다. 예전에는 IDB에서 claim request를 뒤져 bolt11을
  // 꺼냈는데, 인보이스를 클레임이 아니라 에스크로 이후에 받게 되면서 거기엔
  // 더 이상 없다. `sponsorInvoice`는 금액·소유자·만료 검증을 통과한 것만 들어온다
  // (불변조건 I-011) — 여기서 다시 의심할 필요가 없다.
  const sponsorBolt11 = order.sponsorInvoice;
  if (!sponsorBolt11) {
    // 도달하면 FSM에 구멍이 뚫린 것이다. paid/sponsor_wins는 invoiced를 거쳐야만
    // 오는데 invoiced는 검증된 인보이스 없이는 만들어지지 않는다(I-010).
    console.error('[Admin] 지급 대상 인보이스가 없다 — FSM 불변조건 위반:', orderId, order.state);
    return { success: false, error: 'NO_SPONSOR_BOLT11' };
  }

  // 만료는 제출 시점에 한 번 봤지만, 그 사이 계좌 전달 + 원화 이체 + 컨펌이
  // 지나갔다. 결제를 쏘기 직전에 다시 본다 — 만료된 인보이스로 쏘면 LN이
  // 거절하고 그 이유가 로그 깊숙이 묻힌다.
  const decoded = decodeBolt11(sponsorBolt11);
  if (decoded && decoded.expiresAt > 0 && decoded.expiresAt <= Math.floor(Date.now() / 1000)) {
    console.warn('[Admin] 후원자 인보이스 만료 — 재제출 필요:', orderId);
    void publishInvoiceRejected(orderId, order.sponsorPubkey!, 'EXPIRED_BEFORE_PAYOUT', order.payoutSat ?? 0)
      .catch(() => {});
    return { success: false, error: 'INVOICE_EXPIRED' };
  }

  // 결제 전송
  try {
    const result = await lnAdapter.payInvoice(sponsorBolt11);
    if (result.status !== 'succeeded') {
      console.warn('[Admin] Disbursement failed for', orderId, result.failureReason);
      return { success: false, error: result.failureReason ?? 'PAYMENT_FAILED' };
    }
    // preimage는 찍지 않는다 — 수령 증명이라도 콘솔에 남길 이유가 없다(감사 A-4).
    console.log('[Admin] Disbursement succeeded for', orderId);
  } catch (e) {
    console.error('[Admin] Disbursement error for', orderId, e);
    return { success: false, error: 'PAYMENT_ERROR' };
  }

  // 성공 → disbursed 플래그 기록
  // 릴레이 에코 수신 시 upsertOrder의 updatedAt >= 비교에서 드롭되지 않도록
  // 현재 로컬 상태보다 반드시 큰 타임스탬프를 사용한다.
  const freshOrder = getOrder(orderId);
  const baseOrder = freshOrder ?? order;
  const updatedOrder: Order = {
    ...baseOrder,
    disbursed: true,
    updatedAt: Math.max(Math.floor(Date.now() / 1000), baseOrder.updatedAt + 1),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', orderId, 'marked as disbursed');
  } catch (e) {
    // 결제는 성공했지만 발행 실패 — 로그에 남김 (재시도 시 ALREADY_DISBURSED 아닌 상태)
    console.error('[Admin] Disbursement publish failed for', orderId, e);
    return { success: false, error: 'PUBLISH_FAILED_AFTER_PAYMENT' };
  }

  return { success: true };
}

/**
 * 분쟁 판정: Sponsor 승리 (remitted → sponsor_wins).
 *
 * 1. FSM 검증
 * 2. Hold invoice settle (아직 accepted 상태인 경우)
 * 3. kind 30402 발행 (state: sponsor_wins)
 * 4. Sponsor에게 BTC 자동 송금 (fire-and-forget)
 */
export async function resolveDisputeSponsorWins(
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
  const order = getOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (!canTransition(order.state, 'sponsor_wins')) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → sponsor_wins` };
  }

  // Hold invoice settle (프리이미지가 있고 아직 accepted 상태인 경우)
  const preimage = getPreimage(orderId);
  if (preimage && lnAdapterRef) {
    const entry = getEscrowEntry(orderId);
    if (entry) {
      try {
        const status = await lnAdapterRef.lookupHoldInvoice(entry.paymentHash);
        if (status === 'accepted') {
          await lnAdapterRef.settleInvoice(preimage);
          console.log('[Admin] Hold invoice settled for sponsor_wins:', orderId);
        } else if (status === 'settled') {
          console.log('[Admin] Hold invoice already settled (safety net) for:', orderId);
        } else if (status === 'cancelled') {
          // BTC 이미 환불됨 — sponsor_wins 판정이지만 BTC 정산 불가
          console.error('[Admin] Hold invoice cancelled, cannot settle for sponsor_wins:', orderId);
          return { success: false, error: 'INVOICE_ALREADY_CANCELLED' };
        }
      } catch (e) {
        console.error('[Admin] Hold invoice settle failed for sponsor_wins:', orderId, e);
        return { success: false, error: 'SETTLE_FAILED' };
      }
    }
  } else {
    // 프리이미지가 없으면 settle을 못 한다 = BTC를 못 받았다. 그런데 아래에서는
    // 후원자에게 지급이 나간다 — **어드민이 받지도 않은 돈을 주는 유일한 경로**였다.
    // (escrow-store가 아직 복원되지 않은 새 기기에서 판정하면 실제로 도달한다.)
    console.error(
      '[Admin] 프리이미지 없이 sponsor_wins 불가 — 정산할 수 없는데 지급이 나간다:',
      orderId, !preimage ? 'no-preimage' : 'no-adapter',
    );
    return { success: false, error: 'CANNOT_SETTLE' };
  }

  const updatedOrder: Order = {
    ...order,
    state: 'sponsor_wins',
    status: 'sold',
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', orderId, 'resolved: sponsor_wins');
    notifyTransition(updatedOrder);
  } catch (e) {
    console.error('[Admin] Failed to publish sponsor_wins for', orderId, e);
    return { success: false, error: 'PUBLISH_FAILED' };
  }

  // Sponsor에게 BTC 자동 송금 (fire-and-forget)
  void disburseSponsor(orderId).then(result => {
    if (!result.success) {
      console.warn('[Admin] Auto-disbursement failed for sponsor_wins:', orderId, result.error);
    }
  });

  // 스폰서 보증금 환불 (sponsor_wins = 스폰서 정당, fire-and-forget)
  void handleDepositOnTransition(updatedOrder, 'sponsor_wins', lnAdapterRef).catch(err =>
    console.warn('[Admin] Sponsor deposit lifecycle failed on sponsor_wins:', orderId, err),
  );

  return { success: true };
}

/**
 * 분쟁 판정: Customer 승리 (remitted → customer_wins).
 *
 * 1. FSM 검증
 * 2. Hold invoice cancel (아직 accepted 상태인 경우) → BTC 자동 환불
 *    이미 settled인 경우 → 경고 (별도 LN 결제 환불 필요)
 * 3. kind 30402 발행 (state: customer_wins)
 */
export async function resolveDisputeCustomerWins(
  orderId: string,
): Promise<{ success: boolean; error?: string; warning?: string }> {
  const order = getOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (!canTransition(order.state, 'customer_wins')) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → customer_wins` };
  }

  let warning: string | undefined;

  // Hold invoice cancel (아직 accepted 상태인 경우 → BTC 자동 환불)
  const entry = getEscrowEntry(orderId);
  if (entry && lnAdapterRef) {
    try {
      const status = await lnAdapterRef.lookupHoldInvoice(entry.paymentHash);
      if (status === 'accepted') {
        await lnAdapterRef.cancelInvoice(entry.paymentHash);
        console.log('[Admin] Hold invoice cancelled for customer_wins:', orderId);
      } else if (status === 'settled') {
        // Safety net이 이미 settle함 → BTC가 Admin에게 확정됨
        // 별도 LN 결제로 Customer에게 환불 필요 (수동 처리)
        warning = 'INVOICE_ALREADY_SETTLED';
        console.warn(
          '[Admin] Hold invoice already settled for customer_wins:',
          orderId,
          '— manual LN refund to customer required',
        );
      } else if (status === 'cancelled') {
        console.log('[Admin] Hold invoice already cancelled (CLTV timeout) for:', orderId);
      }
    } catch (e) {
      console.error('[Admin] Hold invoice cancel failed for customer_wins:', orderId, e);
      return { success: false, error: 'CANCEL_FAILED' };
    }
  } else {
    console.warn('[Admin] Cannot cancel: missing', !entry ? 'escrowEntry' : 'lnAdapter', 'for', orderId);
  }

  const updatedOrder: Order = {
    ...order,
    state: 'customer_wins',
    status: 'sold',
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', orderId, 'resolved: customer_wins');
    notifyTransition(updatedOrder);
  } catch (e) {
    console.error('[Admin] Failed to publish customer_wins for', orderId, e);
    return { success: false, error: 'PUBLISH_FAILED' };
  }

  // 스폰서 보증금 몰수 (customer_wins = 스폰서 트롤링 판정, fire-and-forget)
  void handleDepositOnTransition(updatedOrder, 'customer_wins', lnAdapterRef).catch(err =>
    console.warn('[Admin] Sponsor deposit lifecycle failed on customer_wins:', orderId, err),
  );

  return { success: true, warning };
}

// ============================================================
// Action Handlers (Inbound Request)
// ============================================================

/**
 * order-request 수신 시 자동으로 오더를 생성하고 kind 30402를 발행한다.
 * 이미 존재하는 orderId면 중복 생성하지 않는다.
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
async function handleOrderRequest(request: OrderRequest): Promise<void> {
  const existing = getOrder(request.orderId);
  if (existing) return;

  // 이미 보증금 대기 중인 요청이면 중복 처리 방지
  if (getPendingDeposit(request.orderId)) return;

  const depositPercent = getCustomerDepositPercent();

  // ── 보증금 분기: depositPercent > 0이고 LN 어댑터 + 시세 데이터가 있으면 보증금 요구 ──
  if (depositPercent > 0 && lnAdapterRef && priceTrackerRef) {
    const btcPrice = priceTrackerRef.getSnapshot().price;
    if (btcPrice && btcPrice > 0) {
      const depositSats = Math.round((request.price / btcPrice) * 1e8 * depositPercent / 100);
      if (depositSats > 0) {
        try {
          const now = Math.floor(Date.now() / 1000);
          const expiry = request.expiration - now;
          if (expiry <= 0) return; // 이미 만료

          const DEPOSIT_CLTV_MARGIN = 24 * 60 * 60; // 24시간
          const cltvExpiry = Math.ceil((expiry + DEPOSIT_CLTV_MARGIN) / 600);

          // deposit:orderId 키로 hold invoice 생성 → escrow-store에 자동 저장
          const result = await lnAdapterRef.createHoldInvoice(
            `deposit:${request.orderId}`, depositSats, expiry, cltvExpiry,
          );

          // pending-deposit-store에 저장
          savePendingDeposit({
            orderId: request.orderId,
            customerPubkey: request.pubkey,
            type: 'customer',
            price: request.price,
            expiration: request.expiration,
            depositPaymentHash: result.paymentHash,
            depositBolt11: result.bolt11,
            createdAt: now,
          });

          // Customer에게 deposit-required 알림 발행
          await publishDepositRequired(
            request.orderId, request.pubkey, result.bolt11, request.expiration,
          );
          console.log('[Admin] Deposit required for', request.orderId, `(${depositSats} sats, ${depositPercent}%)`);
          return; // 오더는 보증금 결제 후 생성
        } catch (e) {
          console.warn('[Admin] Deposit creation failed, falling back to direct order:', request.orderId, e);
          // 보증금 생성 실패 → 기존 플로우로 폴백
        }
      }
    }
  }

  // ── 기존 플로우: 오더 즉시 발행 ──
  await createOrder(request);
}

/**
 * order-request로부터 오더를 생성하고 kind 30402를 발행한다.
 * @returns 발행 성공 여부 (호출측에서 후속 처리 분기에 사용)
 */
export async function createOrder(request: OrderRequest, depositPaymentHash?: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const newOrder: Order = {
    orderId: request.orderId,
    status: 'active',
    state: 'requested',
    customerPubkey: request.pubkey,
    price: request.price,
    createdAt: now,
    updatedAt: now,
    expiration: request.expiration,
    ...(depositPaymentHash ? { depositPaymentHash } : {}),
    raw: {},
  };

  try {
    await publishOrder(newOrder);
    console.log('[Admin] Auto-created order', request.orderId, 'from order-request');
  } catch (e) {
    console.error('[Admin] Failed to publish order for', request.orderId, e);
    return false;
  }

  // 오더 생성 시점부터 IDB에 이관하여 히스토리 + 채팅을 즉시 활성화 (fire-and-forget)
  idbMigrateOrderWithRequests(newOrder, [request]).catch((err: unknown) =>
    console.warn('[Admin] IndexedDB migration failed for', request.orderId, err),
  );

  return true;
}

/**
 * payment-confirm 수신 시 오더를 paid로 전이하고 kind 30402를 발행한다.
 * escrowed 또는 remitted 상태에서 전이 가능 (Customer의 자동 파싱으로 입금 감지).
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
/** @testing-only */
export async function handlePaymentConfirm(request: Request): Promise<void> {
  const order = getOrder(request.orderId);
  if (!order) return;

  if (order.customerPubkey !== request.pubkey) {
    console.warn('[Admin] payment-confirm pubkey mismatch for', request.orderId);
    return;
  }

  if (!canTransition(order.state, 'paid')) {
    console.warn('[Admin] Cannot transition to paid for', request.orderId, '- current state:', order.state);
    return;
  }

  const updatedOrder: Order = {
    ...order,
    state: 'paid',
    status: 'sold',
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', request.orderId, 'paid (payment-confirm from customer)');
    notifyTransition(updatedOrder);
  } catch (e) {
    console.error('[Admin] Failed to publish paid order for', request.orderId, e);
    return;
  }

  // 스폰서 보증금 환불 (paid = 정상 완료, fire-and-forget)
  void handleDepositOnTransition(updatedOrder, 'paid', lnAdapterRef).catch(err =>
    console.warn('[Admin] Deposit lifecycle failed on paid for', request.orderId, err),
  );

  // Hold invoice settle (프리이미지 제출 → BTC 정산)
  const preimage = getPreimage(request.orderId);
  if (preimage && lnAdapterRef) {
    try {
      await lnAdapterRef.settleInvoice(preimage);
      console.log('[Admin] Hold invoice settled for', request.orderId);

      // Settle 성공 → Sponsor에게 자동 송금 (fire-and-forget)
      void disburseSponsor(request.orderId).then(result => {
        if (!result.success) {
          console.warn('[Admin] Auto-disbursement failed for', request.orderId, result.error);
        }
      });
    } catch (e) {
      console.error('[Admin] Failed to settle hold invoice for', request.orderId, e);
    }
  } else {
    console.warn('[Admin] Cannot settle: missing', !preimage ? 'preimage' : 'lnAdapter', 'for', request.orderId);
  }
}

/**
 * cancel-request 수신 시 오더를 cancelled로 전이하고 kind 30402를 발행한다.
 * remitted 상태에서는 전이 불가 (분쟁 판정 경로로만 종결).
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
/** @testing-only */
export async function handleCancelRequest(request: Request): Promise<void> {
  const order = getOrder(request.orderId);
  if (!order) return;

  if (order.customerPubkey !== request.pubkey) {
    console.warn('[Admin] cancel-request pubkey mismatch for', request.orderId);
    return;
  }

  if (!canTransition(order.state, 'cancelled')) {
    console.warn('[Admin] Cannot cancel order', request.orderId, '- current state:', order.state);
    return;
  }

  const updatedOrder: Order = {
    ...order,
    state: 'cancelled',
    status: 'sold',
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', request.orderId, 'cancelled (cancel-request from customer)');
    notifyTransition(updatedOrder);
  } catch (e) {
    console.error('[Admin] Failed to publish cancelled order for', request.orderId, e);
    return;
  }

  // 보증금 cancel/settle
  void handleDepositOnTransition(order, 'cancelled', lnAdapterRef).catch(e =>
    console.warn('[Admin] Deposit lifecycle failed on cancel for', request.orderId, e),
  );
}

/**
 * account-info 수신 시 후원자에게 알림만 보낸다 (상태 전이 없음).
 * Customer가 Sponsor에게 NIP-44 암호화 계좌 정보를 전달한 것으로,
 * Admin은 분쟁 시 commitment 태그로 검증할 수 있다.
 *
 * 후원자 입장에선 여기가 원화를 보낼 수 있게 되는 순간이라, 알림이 필요한
 * 유일한 지점이다. 계좌 내용 자체는 Admin이 읽을 수 없고 읽을 필요도 없다.
 */
function handleAccountInfo(request: Request): void {
  console.log('[Admin] account-info received for', request.orderId, 'from', request.pubkey);

  const order = getOrder(request.orderId);
  if (!order) return;

  // 고객 본인이 보낸 것만 인정한다 — 남이 흘린 이벤트로 알림을 유발시킬 수 없게.
  if (order.customerPubkey !== request.pubkey) {
    console.warn('[Admin] account-info pubkey mismatch for', request.orderId);
    return;
  }

  // 상태를 바꾸지 않는 알림이라 canTransition 같은 방어가 없다. 릴레이는 어드민이
  // 부팅할 때마다 과거 이벤트를 전부 다시 보내므로, 이 가드가 없으면 어드민을
  // 만질 때마다 옛 주문의 "계좌 도착" 알림이 계속 날아간다.
  if (!claimNotification(request.eventId)) return;

  notifyAccountInfoArrived(order);
}

/**
 * dispute-message 수신 시 NIP-44 복호화 후 IDB에 자동 저장한다.
 * 디테일 페이지 미진입 상태에서도 분쟁 메시지를 영구 보존하기 위함.
 * 리액티브 스토어는 갱신하지 않음 (on-demand 구독이 담당).
 */
async function handleDisputeMessage(request: Request): Promise<void> {
  const signer = getSigner();
  if (!signer) return;
  const event = request.raw as { id: string; pubkey: string; content: string; tags: string[][]; created_at: number };
  await processDisputeEvent(event, request.orderId, (_content, senderPubkey, recipientPubkey) => {
    const remotePubkey = senderPubkey === APP_PUBKEY ? recipientPubkey : senderPubkey;
    return signer.nip44Decrypt(remotePubkey, event.content);
  });
}

/**
 * claim 수신 시 오더를 requested → claimed로 전이하고 kind 30402를 발행한다.
 * - 오더가 없거나 전이 불가면 무시 (선착순: 이미 claimed면 후속 클레임 거부)
 * - 인보이스가 없거나 디코딩 실패면 무시
 * - 인보이스 금액이 현재 시세 대비 0.95~1.05 범위 밖이면 무시
 * - sponsorPubkey를 기록하여 이후 유동성 검증 등에 사용
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
/** @testing-only */
export async function handleClaim(request: ClaimRequest): Promise<void> {
  const order = getOrder(request.orderId);
  if (!order) {
    console.warn('[Admin] Claim for unknown order:', request.orderId);
    return;
  }

  if (!canTransition(order.state, 'claimed')) {
    console.warn('[Admin] Cannot claim order', request.orderId, '- current state:', order.state);
    return;
  }

  // 자기 주문 자기가 클레임 금지.
  // 고객앱과 후원자앱이 한 앱으로 합쳐지면서 한 키가 양쪽 역할을 모두 하게 됐다.
  // 막지 않으면 자기 주문을 자기가 받아 에스크로 유동성과 라우팅 수수료만
  // 태울 수 있고, 무엇보다 그 오더는 customerPubkey === sponsorPubkey가 되어
  // "내가 어느 역할로 참여했는가"를 유도할 수 없게 된다(내역 화면의 전제).
  // UI도 거르지만 진짜 방어는 여기다 — kind 1111은 누구나 서명해 쏠 수 있다.
  if (request.pubkey === order.customerPubkey) {
    console.warn('[Admin] Self-claim rejected for', request.orderId);
    return;
  }

  // 인보이스는 여기서 받지 않는다. 클레임은 "내가 맡겠다"일 뿐이고,
  // 지급받을 인보이스는 에스크로가 잡힌 뒤(`escrowed → invoiced`)에 받는다.
  // 근거 = docs/DESIGN-LATE-INVOICE.md — 후원자 유동성 사정이 고객의 결제를
  // 막지 않게 하고, 인보이스가 묵어 만료되는 구간을 줄인다.

  const updatedOrder: Order = {
    ...order,
    state: 'claimed',
    sponsorPubkey: request.pubkey,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', request.orderId, 'claimed by', request.pubkey);
  } catch (e) {
    console.error('[Admin] Failed to publish claimed order for', request.orderId, e);
    return;
  }

  // ── 후원자 보증금 (pre-verification gate) ──
  const sponsorDepositPercent = getSponsorDepositPercent();
  if (sponsorDepositPercent > 0 && lnAdapterRef) {
    try {
      // 인보이스가 없어졌으므로 시세로 기준액을 잡는다. 보증금은 어림값이면
      // 충분하다 — 담보 크기지 지급액이 아니다.
      const btcPrice = priceTrackerRef?.getSnapshot().price;
      const basisSat = btcPrice && btcPrice > 0 ? computePayoutSat(order.price, btcPrice) : null;
      if (!basisSat) throw new Error('시세 없음 — 보증금 산출 불가');
      const depositSats = Math.max(1, Math.round(basisSat * sponsorDepositPercent / 100));
      const now = Math.floor(Date.now() / 1000);
      const expiry = Math.max(300, order.expiration - now);
      const DEPOSIT_CLTV_MARGIN = 24 * 60 * 60; // 24시간
      const cltvExpiry = Math.ceil((expiry + DEPOSIT_CLTV_MARGIN) / 600);

      const result = await lnAdapterRef.createHoldInvoice(
        `deposit:sponsor:${request.orderId}`, depositSats, expiry, cltvExpiry,
      );

      savePendingDeposit({
        orderId: request.orderId,
        customerPubkey: order.customerPubkey,
        type: 'sponsor',
        sponsorPubkey: request.pubkey,
        price: order.price,
        expiration: order.expiration,
        depositPaymentHash: result.paymentHash,
        depositBolt11: result.bolt11,
        createdAt: now,
      });

      // Sponsor에게 deposit-required 알림 발행
      await publishDepositRequired(
        request.orderId, request.pubkey, result.bolt11, order.expiration,
      );

      console.log('[Admin] Sponsor deposit required for', request.orderId, depositSats, 'sats');
    } catch (e) {
      console.error('[Admin] Sponsor deposit creation failed for', request.orderId, e);
    }
  }
}

/**
 * remit-request 수신 시 오더를 escrowed → remitted로 전이하고 kind 30402를 발행한다.
 * Sponsor가 원화 송금 완료를 통보한 것으로, sponsorPubkey 검증 후 전이한다.
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
async function handleRemitRequest(request: Request): Promise<void> {
  const order = getOrder(request.orderId);
  if (!order) return;

  if (order.sponsorPubkey !== request.pubkey) {
    console.warn('[Admin] remit-request pubkey mismatch for', request.orderId);
    return;
  }

  if (!canTransition(order.state, 'remitted')) {
    console.warn('[Admin] Cannot transition to remitted for', request.orderId, '- current state:', order.state);
    return;
  }

  const updatedOrder: Order = {
    ...order,
    state: 'remitted',
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', request.orderId, 'remitted (remit-request from sponsor)');
    notifyTransition(updatedOrder);
  } catch (e) {
    console.error('[Admin] Failed to publish remitted order for', request.orderId, e);
  }
}

// ============================================================
// IndexedDB Sync Helpers (fire-and-forget)
// ============================================================

/**
 * Admin이 발행한 오더를 무조건 IDB에 반영한다.
 *
 * 예전에는 "이미 IDB에 있을 때만" 갱신했다. 그 게이트는 스팸 방어로 넣은
 * 것이었지만 실제로는 아무것도 막지 못했다 — 받아들인 order-request는 전부
 * createOrder에서 idbMigrateOrderWithRequests를 타고 이미 IDB에 들어온다.
 * 게이트가 막고 있던 건 스팸이 아니라 **다른 기기로의 동기화**였다.
 *
 * 즉 주문을 생성한 기기에서만 IDB가 채워져서, 다른 기기의 Admin은 오더를
 * 릴레이로 다 받고도 IDB가 비어 있었다. 그 결과 disburseSponsor가 후원자
 * bolt11을 못 찾아 실패하고(NO_SPONSOR_BOLT11), 주문 상세 화면이 아예 안 열려
 * 분쟁 판정도 불가능했다. PC에서 검증하고 모바일에서 중재하는 게 막혀 있던 이유다.
 *
 * Admin은 모든 오더의 발행자이자 소유자라 "내가 관여 안 한 오더"라는 게 없다.
 * 게이트를 없애고, 진짜 쓰레기(아무도 안 건드린 만료 의뢰)는 GC로 치운다(cleanup.ts).
 */
async function syncOrderToIdb(order: Order): Promise<void> {
  try {
    await idbUpsertOrder(order);
  } catch (err) {
    console.warn('[Admin] IndexedDB order sync failed for', order.orderId, err);
  }
}

/**
 * 요청도 무조건 IDB에 남긴다(위와 같은 이유).
 *
 * orders와 requests는 서로 외래키가 없는 독립 스토어라 순서를 맞출 필요가 없다.
 * catch-up 중 요청이 오더보다 먼저 들어와도 orderId 인덱스로 나중에 정상 조회된다.
 */
async function syncRequestToIdb(request: Request): Promise<void> {
  try {
    await idbUpsertRequest(request);
  } catch (err) {
    console.warn('[Admin] IndexedDB request sync failed for', request.orderId, err);
  }
}
