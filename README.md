# PairBuy — Bitcoin ↔ KRW Escrow over Nostr

A peer-to-peer escrow that pairs people who want to **pay or sell with bitcoin** with people who want to
**acquire bitcoin without an exchange** by sending Korean won bank transfers. Nostr is the message bus; a single
long-running daemon is the escrow agent.

> A side project exploring real payment engineering: escrow state machines, Lightning hold invoices, taproot
> script-path escrows, fidelity bonds, crash-safe side effects, and dispute resolution.

Two tracks share one app and one key per user:

| | Lightning track | On-chain track |
|---|---|---|
| Use case | Pay a Coupang order with BTC — a sponsor pays the KRW virtual account and receives BTC | Non-KYC BTC ↔ KRW trade |
| Escrow | LN **hold invoice** on the daemon's node | **2-of-3 taproot** output (customer / sponsor / admin), key path provably unspendable |
| Happy path | Customer confirms KRW → daemon settles the hold invoice → pays the sponsor's invoice | Sponsor pre-signs the release, customer co-signs after seeing the KRW — **no admin key involved** |
| If the operator disappears | The HTLC times out and refunds the customer | A CSV timelock leaf (~8 weeks) lets the customer sweep alone |
| Bonds | Optional LN hold-invoice deposits (operator setting) | Always-on LN hold-invoice deposits |

---

## How it works

```
 user app (static SPA)                       nostr relays                     admin app (static SPA)
 customer + sponsor, one key ──kind 1111 requests──▶ ◀──kind 1111 commands── operator key (NIP-46 signer)
                             ◀──kind 30402 orders──   ──kind 30078 status──▶
                                                    ▲
                                                    │ (outbound only — no open ports)
                                             ┌──────┴──────┐
                                             │   daemon    │── LND REST (hold invoices, payouts)
                                             │  Node 24 +  │── mempool.space REST (chain)
                                             │   SQLite    │── Web Push (FCM / Apple)
                                             └─────────────┘
```

- **One writer.** Every state transition happens in the daemon (`daemon/`). Users only send requests; the admin
  app is a remote control that sends signed commands and never holds the app key or node credentials.
- **Decisions are transactions.** A handler runs inside one SQLite transaction with no network I/O and records
  the *intent* of each side effect (settle, cancel, pay, broadcast, publish, push) alongside the state change.
  A worker executes effects afterwards; every executor is idempotent (look up before acting), so a crash at any
  point converges on restart. A state that presumes an irreversible effect (`paid`, `settling`) is only
  published after the effect is confirmed.
- **Secrets are derived.** Hold-invoice preimages and per-order on-chain admin keys come from one seed via
  HMAC with versioned labels. Losing the database never loses funds.
- **The close reason decides the money.** Each track has a `Record<Reason, Rule>` table mapping why a trade ended
  to what happens to the escrow and to each party's bond. Adding a reason breaks the build until it is handled.
- **Time is explicit.** Every deadline, CLTV and retention window lives in a timing module, and the inequalities
  between them (e.g. *bond CLTV must outlive the worst-case trade*) are unit tests.

### Lightning track

```
requested ⇄ claimed → verified → escrowed → invoiced → remitted → paid
                                                        ├→ sponsor_wins / customer_wins   (operator ruling)
cancelled · expired (Coupang deadline) · admin_closed
```

The payout amount is fixed once, at approval, from the spot price; the escrow amount is derived from it, so the
sponsor's invoice must match **exactly**. The sponsor registers their payout invoice only after the customer's
BTC is locked, and account details are only released after that (so nobody sends KRW to an unfunded trade).
Liquidity is probed with a random payment hash right before the bank transfer — it warns, it does not block.
If a disputed escrow approaches its HTLC expiry, the daemon settles it first so it can still rule either way.

### On-chain track

```
leaf 1  <C> CHECKSIGVERIFY <S> CHECKSIG      release (normal)
leaf 2  <A> CHECKSIGVERIFY <C> CHECKSIG      refund / customer wins
leaf 3  <A> CHECKSIGVERIFY <S> CHECKSIG      sponsor wins
leaf 4  <8064> CSV DROP <C> CHECKSIG         operator gone → customer sweeps alone
internal key: BIP-341 NUMS point; tree shape pinned as [[1,2],[3,4]]
```

The price locks when the funding confirms. Every non-terminal state has a deadline anchored to a point the
responsible party cannot move, so the total option window is bounded (105 minutes). Clients derive the escrow
address themselves before showing it, and before signing anything they rebuild the transaction from their own
records and require a byte-identical match. The admin always signs last; the release path never needs the admin.

---

## Repository

```
shared/     FSMs, close-reason tables, timing, event codecs, taproot scripts & tx builders (runtime-agnostic core)
daemon/     the escrow agent — ingress, dispatcher, effect queue, hold-invoice machine, LN + chain watchers
customer/   unified user app (React 19) — both roles, both tracks; customer/userscript/ parses Coupang orders
admin/      operator remote control (React 19)
sponsor/    redirect shell for a retired domain
```

## Docs

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Daemon internals and invariants, admin command channel, user app, notifications |
| [docs/LN-TRACK.md](docs/LN-TRACK.md) | Lightning FSM, close reasons → money, timing values and inequalities |
| [docs/ONCHAIN-TRACK.md](docs/ONCHAIN-TRACK.md) | Script tree, FSM, signing order, fees, timing, invariants |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Nostr event kinds, tags, requests and notices |
| [docs/RISKS.md](docs/RISKS.md) | Open risks, trust model, attack scenarios and their defenses |
| [docs/DAEMON-DEPLOY.md](docs/DAEMON-DEPLOY.md) | Operations runbook |
| [docs/ONCHAIN-SIGNET-DRILL.md](docs/ONCHAIN-SIGNET-DRILL.md) | Signet drill runbook |

The docs are written in Korean.

## Stack

TypeScript (strict) everywhere · React 19 + Vite for the web apps · Node 24 + `node:sqlite` + esbuild for the
daemon · nostr-tools · `@scure/btc-signer` · LND REST · vitest (shared, daemon, customer, admin), CI on master and pull requests.

```bash
pnpm install
pnpm verify          # typecheck + tests, all packages
pnpm build:customer && pnpm build:admin && pnpm build:daemon
```
