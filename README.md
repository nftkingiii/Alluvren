# Alluvren

Alluvren is a private-fund redemption shortfall desk prototype. It models deterministic partial allocations against a specific batch version, requires separated fund and treasury review, and uses BitSafe Decentralization Manager governance for threshold-controlled finalization.

## Reproduce it

Judges and reviewers: follow [REPRODUCE.md](REPRODUCE.md). How the nodes, thresholds and operators are arranged, and what happens when any one node fails, is in [DECENTRALIZATION.md](DECENTRALIZATION.md). On a BitSafe LocalNet started with the DecMan hackathon kit, two commands set up Alluvren and run the demonstrations:

```bash
bash infra/setup-localnet.sh
bash infra/demo-localnet.sh
```

## Current state

- `alluvren-v1` 0.4.0: governed fund policies with role quorums, BitSafe-governed finalization, investor-private redemption records, and sealed batches that governance approves without seeing per-investor rows (`artifacts/`, checksums in `artifacts/SHA256SUMS.txt`).
- Verified on BitSafe LocalNet: threshold-bound finalization, policy governance, signed-in role-bound writes through the backend, and a hosting-node outage with recovery. Evidence and limits are in `EVIDENCE.md`.
- The frontend has a Live ledger tab for signed-in users (LocalNet) and a clearly labelled simulated walkthrough.
- No real cash or token settlement: investor receipts are demo acknowledgments; units are 1:1 with zero fees. All LocalNet nodes are run by one developer, so independent operation is not demonstrated.

## Repository map

- `daml/`: Daml templates, tests, and design notes
- `backend/`: Node API with sign-in and role-bound ledger writes, and tests
- `frontend/`: React/Vite application, assets, and browser tests
- `infra/`: LocalNet setup, demonstrations and VM recovery scripts
- `artifacts/`: versioned DARs, checksums, and changelog
- `REPRODUCE.md`: step-by-step reproduction on BitSafe LocalNet
- `DECENTRALIZATION.md`: nodes, thresholds, operators and outage behaviour
- `EVIDENCE.md`: what was verified, when, and what was not

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

LocalNet integration tests require the BitSafe Decentralization Manager LocalNet and credentials configured locally. See `REPRODUCE.md` and `infra/` before running state-changing tests. Never commit real `.env` files, access tokens, private keys, or VM credentials.

## Upstream dependency

The BitSafe Decentralization Manager source is maintained separately: <https://github.com/DLC-link/decentralization-manager/tree/hackathon/hackathon>. It is intentionally not vendored into this repository.
