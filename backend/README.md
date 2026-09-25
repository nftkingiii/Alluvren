# Alluvren backend adapter

Small Node 20 service between the Alluvren UI, the Decentralization Manager (DecMan) nodes and the participant's JSON Ledger API. No runtime dependencies.

## Security boundary (Gate 8)

- **Sign-in:** local accounts from `ACCOUNTS_FILE` with scrypt password hashes (interim; a CIP-0103 wallet sign-in can replace the login step later). Sessions are random 256-bit IDs in an `HttpOnly; SameSite=Strict` cookie (8 h max, 30 min idle). Failed sign-ins are throttled per account (5 / 5 min) and per IP (30 / 5 min).
- **Every write acts as the signed-in account's party.** Request bodies never choose the acting party, the DecMan node, the approval target, or the confirmation set; those come from the session and from ledger/DecMan read-back.
- **Writes** need an allowed `Origin`, the session's `x-alluvren-csrf` token, the right role, and `WRITES_ENABLED=true`. With the flag off every write returns 403.
- **Privacy:** investors cannot read `/api/workflow` (it lists every investor's allocation); they read only their own records via `/api/me/records`.
- **Errors:** only Daml requirement text (e.g. `Missing required approvals for role ComplianceReviewer`) is passed through; raw ledger/DecMan payloads are not. A ledger timeout returns 504 "outcome unknown" and is never retried automatically.
- The ledger token stays server-side. The service binds to loopback only; do not expose it publicly without TLS (`COOKIE_SECURE=true`) and a reviewed deployment.
- Known limits: sessions are in memory (restart signs everyone out); all LocalNet parties are controlled by one developer, so roles prove mechanics, not organizational independence; the shared ledger user can act for every configured party, so the backend checks are the only party boundary until per-user ledger users exist.

## Roles and endpoints

| Role (account) | Can do |
| --- | --- |
| `FundReviewer`, `TreasuryReviewer`, `ComplianceReviewer`, `AdministratorCheck`, `FinalSignoff` | `POST /api/approvals {batchCid, role}` for batches their party can see; `POST /api/approvals/revoke {approvalCid}` for their own approvals |
| `Operator` (the batch proposer party) | `POST /api/proposals/finalize {batchCid, approvalCids}` for policy batches it proposed |
| `GovernanceMember` (bound to one DecMan node) | `POST /api/governance/confirm {proposalCid}` and `POST /api/governance/execute {proposalCid}` for Alluvren actions only (`FinalizeRedemption`, `FinalizePolicyRedemption`, `UpdateFundPolicy`); execute requires the threshold |
| `Investor` (cannot hold other roles) | `POST /api/claims/acknowledge {entitlementCid}`, `POST /api/outstanding/withdraw {outstandingCid}` for their own records |
| Any signed-in account | `GET /api/auth/me`, `GET /api/me/records`, `POST /api/auth/logout` |
| Any staff account | `GET /api/workflow` |

Public: `GET /healthz`, `POST /api/auth/login {username, password}`.

## Setup

1. Copy `.env.example` to `.env` and `accounts.example.json` to `accounts.json` (both git-ignored).
2. For each account run `npm run hash-password`, type the password, and paste the hash into `accounts.json`.
3. Start with the environment loaded by the launching process (`.env` is not read automatically): `npm start`.

`npm test` runs the authorization tests against mock DecMan nodes and a mock Ledger API.
