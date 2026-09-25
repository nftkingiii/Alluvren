# Alluvren

Alluvren is a private-fund redemption shortfall desk prototype. It models deterministic partial allocations against a specific batch version, requires separated fund and treasury review, and uses BitSafe Decentralization Manager governance for threshold-controlled finalization.

## Current state

- The local BitSafe LocalNet Gate 6 end-to-end scenario passed: insufficient threshold, stale-batch rejection, reviewer-separation rejection, successful target-bound finalization, and replay rejection.
- The Google Cloud test VM is stopped. Its LocalNet data was retained.
- The frontend's default business desk is simulated browser state. The connect panel reads LocalNet state; the backend is read-only and blocks writes until authentication, party-role authorization, and transaction read-back are implemented.
- No real cash/token settlement or independent-operator validation is implemented. Demo units are fixed 1:1 with zero fees.
- `artifacts/alluvren-v1-0.1.0.dar` is the current LocalNet DAR. See `artifacts/SHA256SUMS.txt` and `EVIDENCE.md` for package identity and test evidence. It is not evidence of an upload to the shared HackCanton DevNet.

## Repository map

- `daml/`: Daml templates, tests, and design notes
- `backend/`: read-only Node API and tests
- `frontend/`: React/Vite application, assets, and browser tests
- `infra/`: LocalNet recovery and Gate 6 test scripts
- `artifacts/`: versioned DARs, checksums, and changelog
- `BUILD_EXECUTION_PLAN.md`, `PROJECT_STATE.md`, `EVIDENCE.md`: current execution state and proof
- `LUNA_HANDOFF.md`: historical integration handoff; verify against current state before relying on it

## Local development

Frontend:

```powershell
cd frontend
npm ci
npm test
npm run build
npm run dev
```

Backend:

```powershell
cd backend
npm ci
npm test
```

LocalNet integration tests require the BitSafe Decentralization Manager LocalNet and credentials configured locally. See `BUILD_EXECUTION_PLAN.md`, `PROJECT_STATE.md`, and `infra/` before running state-changing tests. Never commit real `.env` files, access tokens, private keys, or VM credentials.

## Upstream dependency

The BitSafe Decentralization Manager source is maintained separately: <https://github.com/DLC-link/decentralization-manager/tree/hackathon/hackathon>. It is intentionally not vendored into this repository.
