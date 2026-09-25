# Alluvren frontend

Warm graphite redemption workspace with Desk, Requests, Batches, Approvals and Activity views, plus a simulated investor perspective.

## Run

From this directory:

```powershell
npm install
npm run dev
```

Open the URL Vite prints (normally http://127.0.0.1:5173).

```powershell
npm test
npm run build
npx playwright test
```

Browser tests expect the dev server at port 5173 and installed Google Chrome. Screenshots are saved in ignored `test-results/`.

## Demo versus live evidence

- The default experience is explicitly simulated in browser memory. Refresh or Reset demo clears it. No credentials are required, no VM starts and no ledger command is sent.
- Integer largest-remainder allocations follow the design specification. They are a client preview, not ledger authority.
- Approval versions, mandatory business roles, member threshold, stale execution blocking and single-use finalization/acknowledgment are demonstrated by a pure state machine. This does not establish independent operator identities or server-side authorization.
- A replacement simulates a new batch; it does not edit a frozen contract. Production recovery/reproposal must use actual supported Daml choices.
- Investor perspective is a demonstration, not authenticated privacy enforcement. Demo receipts are not cash settlement.
- The connection dialog fetches `/healthz` and `/api/workflow`, showing parsed governance proposals, threshold progress, recent audit events, and structured read-only summaries of active Alluvren redemption batches and role approvals. The DecMan query exposes typed create arguments only for those two templates; the backend projects known fields and never sends raw disclosure blobs or unknown fields to the browser. This live evidence remains separate from simulated allocations.
- Development proxies these endpoints to the existing backend on `127.0.0.1:8787`. Optionally set `VITE_ALLUVREN_API_URL` to a backend URL at build time. Configure the backend CORS allowlist for that frontend origin.
- The backend currently disables all governance writes. Do not enable live approval/finalization until authenticated operator authorization, role/party binding, contract-state read-back and failure/retry handling are implemented and tested.

## Demo sequence

1. Open Review batch. Review as the fund reviewer.
2. Simulate reserve change and create version 2.
3. Select version 1: old approvals remain attached, execution is blocked.
4. Open current, approve both fund and treasury, then confirm as members A and B.
5. Finalize the demo batch.
6. Switch the top-right demo perspective to Aster Capital and acknowledge/download the demo receipt.
7. Return to operator Activity to inspect or export the simulated audit record.

The Google Cloud VM can remain stopped throughout frontend development.

## Feedback and recovery

Governance evidence uses a skeleton on first load and preserves the previous snapshot during refresh. Failed reads retry once; requests can be cancelled. Unavailable, denied, malformed and empty responses have distinct states with recovery guidance. Failed refreshes retain an explicitly dated snapshot. No live data is substituted with demo data.

Reserve validation is inline and retains the amount entered. Search and filters persist when navigating between views and can be cleared separately. Important demo completion remains visible in the batch result; transient feedback uses semantic icons and colors. Dialogs restore focus and motion respects reduced-motion preferences.

The browser suite covers these states using intercepted test responses, in addition to the demo workflow and responsive checks. These tests do not establish live backend connectivity.
