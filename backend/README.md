# Alluvren backend adapter

Small Node 20 service between the Alluvren UI, the Decentralization Manager (DecMan) nodes and the participant's JSON Ledger API. No runtime dependencies.

## Security boundary (Gate 8)

- **Sign-in is a wallet signature; there are no passwords.** Each account in `ACCOUNTS_FILE` is bound to a CIP-0103 wallet party. `POST /api/auth/challenge {wallet}` returns a one-time text naming the site, the wallet, a nonce and a 5-minute expiry. The wallet signs it (`signMessage`: Ed25519 over the text's UTF-8 bytes) and `POST /api/auth/wallet {wallet, publicKey, signature, message}` checks, without trusting the browser or the wallet: the challenge was issued for this wallet, is unexpired and unused; the public key's Canton fingerprint (`1220` + SHA-256(uint32be(12) ‖ key)) is the wallet party's namespace, so the key owns the party; and the signature verifies. Every refusal returns one generic error. Sessions are random 256-bit IDs in an `HttpOnly; SameSite=Strict` cookie (8 h max, 30 min idle). Failed sign-ins are throttled per wallet (5 / 5 min) and per IP (30 / 5 min).
- **An account's ledger party is either a staff or investor party the server acts for, or the wallet party itself.** Investors whose party is their wallet (`actsThroughWallet`) sign their own acknowledgments and withdrawals in the wallet (CIP-0103 `prepareExecute`); the server refuses to submit as them (409).
- **Every write acts as the signed-in account's party.** Request bodies never choose the acting party, the DecMan node, the approval target, or the confirmation set; those come from the session and from ledger/DecMan read-back.
- **Writes** need an allowed `Origin`, the session's `x-alluvren-csrf` token, the right role, and `WRITES_ENABLED=true`. With the flag off every write returns 403.
- **Privacy:** investors cannot read `/api/workflow` (it lists every investor's allocation); they read only their own records via `/api/me/records`.
- **Errors:** only Daml requirement text (e.g. `Missing required approvals for role ComplianceReviewer`) is passed through; raw ledger/DecMan payloads are not. A ledger timeout returns 504 "outcome unknown" and is never retried automatically.
- **Participant failover:** `LEDGER_JSON_API_URL` may list several participants that host the business parties, primary first. Participants reporting no connected synchronizer are used last (a disconnected one still answers reads, from a stale ledger). Reads move on after any connection or server failure. A command moves on only when it provably never reached the ledger (connection refused, or the participant says it is not connected); rejections and timeouts are never resubmitted elsewhere.
- The ledger token stays server-side. The service binds to loopback only; do not expose it publicly without TLS (`COOKIE_SECURE=true`) and a reviewed deployment.
- Known limits: sessions are in memory (restart signs everyone out); all LocalNet parties are controlled by one developer, so roles prove mechanics, not organizational independence; the shared ledger user can act for every configured party, so the backend checks are the only party boundary until per-user ledger users exist.

## Roles and endpoints

| Role (account) | Can do |
| --- | --- |
| `FundReviewer`, `TreasuryReviewer`, `ComplianceReviewer`, `AdministratorCheck`, `FinalSignoff` | `POST /api/approvals {batchCid, role}` for batches their party can see; `POST /api/approvals/revoke {approvalCid}` for their own approvals |
| `Operator` (the batch proposer party) | `POST /api/proposals/finalize {batchCid}` for policy batches it proposed; the server proposes with the approvals valid at that moment and refuses a repeat of an open proposal |
| `GovernanceMember` (bound to one DecMan node) | `POST /api/governance/confirm {proposalCid}` and `POST /api/governance/execute {proposalCid}` for Alluvren actions only (`FinalizeRedemption`, `FinalizePolicyRedemption`, `UpdateFundPolicy`); execute requires the threshold |
| `Investor` (cannot hold other roles) | `POST /api/claims/acknowledge {entitlementCid}`, `POST /api/outstanding/withdraw {outstandingCid}` for their own records; an investor whose party is its wallet does these in the wallet instead |
| Any signed-in account | `GET /api/auth/me`, `GET /api/me/records`, `POST /api/auth/logout` |
| Any staff account | `GET /api/workflow` |

Public: `GET /healthz`, `POST /api/auth/challenge {wallet}`, `POST /api/auth/wallet {wallet, publicKey, signature, message}`.

## Setup

1. Copy `.env.example` to `.env` and `accounts.example.json` to `accounts.json` (both git-ignored).
2. For each account set `wallet` to the person's Wallet Gateway party (`bash infra/wallet-gateway.sh party <name>` on LocalNet), and `party` to the ledger party the account acts as. For a wallet-only investor, `party` is the wallet party.
3. Start with the environment loaded by the launching process (`.env` is not read automatically): `npm start`.

`npm test` runs the authorization tests against mock DecMan nodes and a mock Ledger API.
