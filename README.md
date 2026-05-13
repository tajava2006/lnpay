# Sajwo Tracker — Bitcoin Escrow Marketplace

A peer-to-peer escrow platform that connects people who want to **pay for goods with Bitcoin** and people who want to **acquire Bitcoin without using an exchange** — using the Lightning Network as the settlement layer and Nostr as the communication layer.

> Built as a side project exploring real-world payment engineering: escrow design, Lightning Network hold invoices, fidelity bonds, finite state machines, and dispute resolution.

---

## What It Does

Two parties have complementary needs:

| Role | Problem | Solution |
|---|---|---|
| **Customer** | Wants to buy goods (e.g., on Coupang) but only has Bitcoin | Pays in BTC, receives goods |
| **Sponsor** | Wants to acquire Bitcoin without a centralized exchange | Makes the KRW bank transfer on behalf of the Customer, receives BTC in return |

An **Admin** acts as an escrow agent, holding the Customer's BTC in a Lightning hold invoice while the Sponsor makes the bank transfer. Once payment is confirmed, Admin settles the invoice to release BTC to the Sponsor.

```
Customer                    Admin (Escrow)                Sponsor
   │                             │                          │
   │  ① Request (BTC order)      │                          │
   │ ───────────────────────────→│                          │
   │                             │  ② Claim + LN invoice    │
   │                             │ ←─────────────────────── │
   │                             │  ③ Probe liquidity        │
   │  ④ Claim approved           │                          │
   │ ←─────────────────────────  │                          │
   │  ⑤ Pay hold invoice         │                          │
   │ ───────────────────────────→│  (BTC locked in HTLC)    │
   │                             │  ⑥ Send account info     │
   │                             │ ─────────────────────→   │
   │                             │  ⑦ KRW bank transfer     │
   │                             │          ──────────→ [Shop]
   │                             │  ⑧ Settle → release BTC  │
   │                             │ ─────────────────────→   │
```

---

## Key Technical Design Decisions

### 1. Hold Invoices as Escrow

The core of the escrow mechanism uses **Lightning Network hold invoices** (also called HODL invoices).

A hold invoice is a Lightning invoice where the receiving node holds the HTLC instead of immediately settling it. The payment is "locked" cryptographically until the payee chooses to reveal the preimage (settle) or the CLTV timeout expires (automatic refund).

This maps perfectly to an escrow use case:
- Admin generates the invoice and holds the preimage
- Customer pays — BTC is locked in an HTLC, not yet received by Admin
- If Sponsor confirms KRW transfer: Admin reveals the preimage → **BTC settles to Admin → Admin sends to Sponsor**
- If something goes wrong: Admin doesn't settle → **CLTV timeout → BTC automatically refunded to Customer**

```
State          Admin Action        Result
──────────────────────────────────────────────────
KRW confirmed  settle(preimage)    Admin receives BTC → forwards to Sponsor
Dispute lost   cancel / no-op      CLTV timeout → BTC auto-refunds to Customer
```

This eliminates the need for a trusted backend server to "hold" funds — the Lightning Network protocol itself enforces the escrow conditions.

### 2. Fidelity Bonds — Spam Prevention via Economics

A fully anonymous system (Nostr pubkeys are free to generate) needs a sybil-resistance mechanism that doesn't rely on identity.

**For Customers** — before a request is published to the order book, the Customer must pay a small hold invoice as a **fidelity bond**. Anyone without actual BTC is immediately blocked. The bond is held until a Sponsor is matched, then automatically cancelled (BTC refunded) when the real escrow payment begins.

**For Sponsors** — a Sponsor's claim is only approved after they pay a deposit hold invoice. If the Sponsor fails to make the KRW transfer and loses the dispute, the deposit is **settled (forfeited)**. This makes trolling economically costly.

This mirrors the fidelity bond design used by [RoboSats](https://learn.robosats.com/docs/bonds/), adapted to this two-sided marketplace structure.

```
Fidelity bond lifecycle:
  Customer: requested → [bond held] → escrowed → [bond cancelled, real invoice starts]
  Sponsor:  claimed → [deposit held] → paid/sponsor_wins → [refunded] / customer_wins → [forfeited]
```

### 3. Lightning Liquidity Probing

Before approving a Sponsor's claim, Admin verifies that the Sponsor's Lightning node actually has enough **inbound liquidity** to receive the BTC payment. A Sponsor without inbound capacity can't receive funds even if the transaction completes.

**How probing works:**
Admin sends a payment attempt using a **random payment hash** (one that nobody knows the preimage for) to the Sponsor's node. This probes the real route capacity without actually completing a payment — no fees incurred.

- If the probe reaches the destination and fails with `INCORRECT_PAYMENT_DETAILS` → path exists, liquidity sufficient → **claim approved**
- If the probe fails mid-route with `TEMPORARY_CHANNEL_FAILURE` or `NO_ROUTE` → liquidity insufficient → **claim rejected**

Why not use a hold invoice for probing? Because hold invoices give the *receiver* settle/cancel control — Admin (the sender) can't cancel unilaterally and would have to wait for CLTV expiry. Random-hash probing solves exactly this.

```
Tool          Direction         Who controls cancellation    Use case here
──────────────────────────────────────────────────────────────────────────
Hold invoice  Customer → Admin  Receiver (Admin) ✓           Escrow
Probing       Admin → Sponsor   Sender (Admin)   ✓           Liquidity check
```

### 4. Finite State Machine — Single Source of Truth

All order state is owned exclusively by **Admin**. Customers and Sponsors send requests (Nostr kind 1111), Admin transitions the state and re-publishes the order (Nostr kind 30402). No distributed FSM, no state conflicts.

```
requested → claimed → verified → escrowed → remitted → paid
                                    │                 ├── sponsor_wins
                                    └── paid          └── customer_wins

cancelled: only from requested / claimed / verified
  (no cancellation after escrowed — Sponsor may have already sent KRW)
```

Critical invariants enforced by the FSM:
- `escrowed → cancelled` is **blocked** — prevents Customer from cancelling after Sponsor has acted
- `remitted` can only resolve through Admin dispute judgment — never abandoned mid-air
- Settle only happens on: Customer payment confirmation, `sponsor_wins` judgment, or safety-net auto-settle (10 min before CLTV expiry)

### 5. Dispute Resolution

When a Sponsor claims to have sent KRW but the Customer doesn't confirm, the order enters `remitted` state and Admin mediates:

- Admin opens **separate encrypted chats** (NIP-44) with each party to collect evidence
- Sponsor can submit an **account-reveal** message with their transfer details
- Admin verifies authenticity using a **SHA-256 commitment** — the original `account-info` event contains `sha256(plaintext)`, so any tampering is detectable
- Admin renders a `sponsor_wins` or `customer_wins` verdict, which triggers the corresponding hold invoice settle or cancel

**CLTV safety net:** If Admin hasn't ruled before expiry, the invoice watcher auto-settles 10 minutes before CLTV timeout. This preserves Admin's ability to rule — a settled invoice can still be judged in the Sponsor's favor (forward BTC) or Customer's favor (send BTC back via a new payment). Waiting for CLTV expiry makes recovery impossible; early settle keeps options open.

---

## Architecture

```
┌─────────────────────────────────────┐
│           Nostr Relay Network        │
│   (decentralized message transport)  │
└──────────────┬──────────────────────┘
               │
   ┌───────────┼───────────┐
   ↓           ↓           ↓
Customer     Sponsor      Admin
  App          App          App
(React SPA  (React SPA   (React SPA
+ userscript)  order book)  + LN node control)
```

**pnpm workspace monorepo:**

```
sajwo-tracker/
  shared/          ← @sajwo-tracker/shared (Nostr keys, relays, types, constants)
  customer/        ← BTC buyer app (React 19 SPA)
  customer/userscript/  ← Tampermonkey script (auto-parses Coupang orders via __NEXT_DATA__)
  sponsor/         ← BTC buyer-via-fiat app (React 19 SPA)
  admin/           ← Escrow service (React 19 SPA, no backend)
```

### Store-Subscription Pattern

All state flows through a strict unidirectional architecture:

```
Nostr Relay → Nostr service (background) → Persistent store → UI
```

UI components never touch the relay directly — they subscribe to `localStorage`/`IndexedDB` via `useSyncExternalStore`. The Nostr service layer runs independently of component lifecycle.

### Admin Dual Storage Strategy

Admin runs two parallel storage systems:
- **localStorage** — live queue, aggressively purged on expiry (60s cleanup cycle)
- **IndexedDB** — long-term archive, activated on `escrowed` entry, never deleted

This ensures the active work queue stays lean while all financially relevant records are preserved for audit and dispute resolution.

### Pure Frontend Deployment

All three apps are static SPAs with no backend. Admin-specific challenges solved:

- **Key management:** Admin uses NIP-46 (Nostr Connect) — private key never enters the browser, signing is delegated to a remote signer (nsecBunker)
- **LN config storage:** Lightning node credentials encrypted with NIP-44, stored on a Nostr relay, decrypted into memory only at login
- **LN TLS:** Lightning nodes use self-signed certs that browsers block; solved with nginx reverse proxy (Let's Encrypt frontend, self-signed backend, CORS headers added)

---

## Communication Layer: Nostr

All three parties communicate via [Nostr](https://nostr.com), a decentralized, censorship-resistant messaging protocol using public-key cryptography.

| NIP | Used for |
|-----|----------|
| NIP-01 | Base protocol (event structure, signing, relay comms) |
| NIP-22 | Comment (kind 1111 — all request events) |
| NIP-33 | Addressable events (kind 30402 orders, keyed by orderId) |
| NIP-40 | Expiration timestamps (auto-cleanup of old events) |
| NIP-44 | Versioned encryption (account info, dispute chat E2E) |
| NIP-46 | Nostr Connect (Admin remote signing) |
| NIP-65 | Relay list / Outbox model (relay discovery) |
| NIP-78 | Arbitrary app data (Admin LN config storage) |
| NIP-99 | Classified listings (kind 30402 order format) |

---

## Tech Stack

| | Customer | Sponsor | Admin | Shared |
|---|---|---|---|---|
| Framework | React 19 | React 19 | React 19 | — |
| Build | Vite | Vite | Vite | (compiled by each app) |
| Language | TypeScript strict | TypeScript strict | TypeScript strict | TypeScript strict |
| Storage | localStorage + IndexedDB | localStorage + IndexedDB | localStorage + IndexedDB | StorageAdapter interface |
| Key mgmt | Random keypair | Random keypair | NIP-46 remote signer | `ensureKeypair()` |
| LN support | — | — | LND + CLN adapters | — |

**Lightning Node support:** Adapter pattern (`LightningAdapter` interface) covers both LND and Core Lightning (CLN), with per-implementation REST API mapping and auth headers.

**Testing:** 41 vitest unit tests covering FSM state transitions, invoice amount validation, and SHA-256 commitment verification — all financially critical logic.

---

## Security Model Highlights

- **FSM invariants tested** — every valid and invalid state transition has a corresponding test case
- **Preimage protection** — NIP-44 encrypted in localStorage, backed up to relay via NIP-78; never in plaintext storage
- **XSS hardened** — userscript notification uses DOM API, not innerHTML
- **Price oracle guards** — claim rejected if all exchange price feeds are down (prevents zero-price invoice bypass)
- **Commitment verification** — SHA-256 hash of account info included in the original event; dispute submissions are automatically verified against it, making data tampering detectable

Full threat model in [THREAT-MODEL.md](THREAT-MODEL.md). Security roadmap in [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md).

---

## Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — Module structure, data flow, storage design
- [PROTOCOL.md](PROTOCOL.md) — Nostr event specs, FSM transition rules, subscription filters
- [THREAT-MODEL.md](THREAT-MODEL.md) — Abuse scenarios and safety invariants
- [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md) — Security improvement backlog
