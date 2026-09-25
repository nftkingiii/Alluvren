# Alluvren backend adapter

Current security boundary: loopback-only, read-only adapter. All POST requests
return 403 until authenticated identities and server-side operator permissions
are implemented. Existing write handlers are disabled; CORS is not authentication.
Do not publicly deploy this adapter or treat node selection as identity proof.
Environment variables must currently be supplied by the launching process; `.env`
is a configuration template and is not automatically loaded by `npm start`.

This small Node 20 service is the application boundary between the Alluvren UI and the configured Decentralization Manager nodes. It exposes the minimum workflow operations needed by the demo:

- `GET /healthz`
- `GET /api/workflow`
- `POST /api/governance/confirm`
- `POST /api/governance/execute`

The read-only workflow endpoint returns parsed pending domain proposals and
confirmations, governance threshold, a bounded recent chain-audit feed, and
allowlisted fields from active `RedemptionBatch` / `RoleApproval` contracts.
DecMan must include `include_payload=true` for those two templates. The backend
projects only known business fields; opaque contract blobs and unknown payload
fields are never forwarded. Set `ALLUVREN_PACKAGE_REF` to a Canton package
reference (for example, `#alluvren-v1`) to enable active contract queries.
Governance writes remain blocked by design; this adapter is not ready
for public deployment or authenticated operator actions.

Copy `.env.example` to `.env` and fill in the LocalNet values. Keep `.env` private. The service intentionally does not accept arbitrary upstream URLs or expose node credentials to the browser.

Run it with:

```text
npm start
```
