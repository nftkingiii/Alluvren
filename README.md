# Alluvren

Alluvren is a private-fund redemption shortfall desk prototype. It models deterministic partial allocations against a specific batch version, requires separated fund and treasury review, and uses BitSafe Decentralization Manager governance for threshold-controlled finalization.

## Reproduce it

Judges and reviewers: follow [REPRODUCE.md](REPRODUCE.md). On a BitSafe LocalNet started with the DecMan hackathon kit, two commands set up Alluvren and run the demonstrations:

```bash
bash infra/setup-localnet.sh
bash infra/demo-localnet.sh
```

## Current state

- `alluvren-v1` 0.3.0: governed fund policies with role quorums, investor-private redemption records, and BitSafe-governed finalization (`artifacts/`, checksums in `artifacts/SHA256SUMS.txt`).
- Verified on BitSafe LocalNet: threshold-bound finalization, policy governance, signed-in role-bound writes through the backend, and a hosting-node outage with recovery. Evidence and limits are in `EVIDENCE.md`.
- The frontend has a Live ledger tab for signed-in users (LocalNet) and a clearly labelled simulated walkthrough.
- No real cash or token settlement: investor receipts are demo acknowledgments; units are 1:1 with zero fees. All LocalNet nodes are run by one developer, so independent operation is not demonstrated.

## Repository map

- `daml/`: Daml templates, tests, and design notes
- `backend/`: Node API with sign-in and role-bound ledger writes, and tests
- `frontend/`: React/Vite application, assets, and browser tests
- `infra/`: LocalNet setup, demonstrations and VM recovery scripts
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
