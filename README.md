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

## Contributions to the Decentralization Manager

Building Alluvren on DecMan turned up gaps in DecMan itself, so we fixed them upstream in [DLC-link/decentralization-manager](https://github.com/DLC-link/decentralization-manager). The first three came straight out of Alluvren's integration. The rest close open DecMan issues, and each went through maintainer review before merging.

| PR | What it does | Issue | Status |
|---|---|---|---|
| [#491](https://github.com/DLC-link/decentralization-manager/pull/491) | Return decoded contract fields from `/contracts/query` on request. Alluvren's backend needed these to read batch and approval fields. | | Merged 2026-09-30 |
| [#490](https://github.com/DLC-link/decentralization-manager/pull/490) | Add three execution gotchas, found while building Alluvren's module, to the custom templates guide | | Merged 2026-09-30 |
| [#493](https://github.com/DLC-link/decentralization-manager/pull/493) | Document requiring business sign-offs when a governed action executes, the pattern Alluvren uses | | Merged 2026-10-01 |
| [#498](https://github.com/DLC-link/decentralization-manager/pull/498) | Refuse reward beneficiary lists the instrument template would reject, in the form and the backend | [#466](https://github.com/DLC-link/decentralization-manager/issues/466) | Merged 2026-10-01 |
| [#500](https://github.com/DLC-link/decentralization-manager/pull/500) | Reset the proposal form when the proposal type changes | [#358](https://github.com/DLC-link/decentralization-manager/issues/358) | Merged 2026-10-01 |
| [#501](https://github.com/DLC-link/decentralization-manager/pull/501) | Keep the Packages tables inside the panel with their headers in view | [#430](https://github.com/DLC-link/decentralization-manager/issues/430) | Merged 2026-10-01 |
| [#502](https://github.com/DLC-link/decentralization-manager/pull/502) | Show the deployed governance rules on the dec party page | [#462](https://github.com/DLC-link/decentralization-manager/issues/462) | Merged 2026-10-01 |
| [#503](https://github.com/DLC-link/decentralization-manager/pull/503) | Let operators star a decparty so it stays at the top of the list | [#406](https://github.com/DLC-link/decentralization-manager/issues/406) | Merged 2026-10-01 |
| [#506](https://github.com/DLC-link/decentralization-manager/pull/506) | Add a mock fixture for the expected package versions (bug reported in [#505](https://github.com/DLC-link/decentralization-manager/issues/505)) | [#505](https://github.com/DLC-link/decentralization-manager/issues/505) | Open, in review |

All of them: [PRs by nftkingiii](https://github.com/DLC-link/decentralization-manager/pulls?q=is%3Apr+author%3Anftkingiii).
