import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, LockKeyhole, LogOut, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { api, restoreSession, signIn, signOut } from "./api.js";

const APPROVAL_ROLES = {
  FundReviewer: "Fund review",
  TreasuryReviewer: "Treasury",
  ComplianceReviewer: "Compliance",
  AdministratorCheck: "Administrator check",
  FinalSignoff: "COO final sign-off",
};

const short = (value = "") => (value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value);
const units = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "—");

function SignIn({ onSignedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (event) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      onSignedIn(await signIn(username.trim(), password));
    } catch (e) {
      setError(e.message);
    } finally {
      setPassword("");
      setPending(false);
    }
  };
  return (
    <form className="live-signin card" onSubmit={submit} aria-labelledby="live-signin-title">
      <h2 id="live-signin-title"><LockKeyhole size={18} /> Sign in to the ledger</h2>
      <p className="muted">Your account decides which party you act as. Every action here is a real LocalNet ledger command.</p>
      <label htmlFor="live-username">Username</label>
      <input id="live-username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
      <label htmlFor="live-password">Password</label>
      <input id="live-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <p className="live-error" role="alert">{error}</p>}
      <button className="button primary" type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

// One action button that prevents double submits and reports ledger results.
function Action({ label, onRun, disabled, tone = "", confirmText }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className={`button ${tone}`}
      disabled={disabled || pending}
      onClick={async () => {
        if (confirmText && !window.confirm(confirmText)) return;
        setPending(true);
        try { await onRun(); } finally { setPending(false); }
      }}
    >
      {pending ? "Submitting…" : label}
    </button>
  );
}

export function LiveLedger({ notify }) {
  const [user, setUser] = useState(undefined);
  const [health, setHealth] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [records, setRecords] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState({});

  const roles = user?.roles ?? [];
  const isInvestor = roles.includes("Investor");

  const load = useCallback(async (who) => {
    if (!who) return;
    setLoadError(null);
    try {
      const [h, r, w] = await Promise.all([
        api.health().catch(() => null),
        api.myRecords(),
        who.roles.includes("Investor") ? Promise.resolve(null) : api.workflow(),
      ]);
      setHealth(h);
      setRecords(r);
      setWorkflow(w);
    } catch (e) {
      setLoadError(e.status === 401 ? "Your session ended. Sign in again." : e.message);
      if (e.status === 401) setUser(null);
    }
  }, []);

  useEffect(() => {
    restoreSession().then(setUser).catch(() => setUser(null));
  }, []);
  useEffect(() => { if (user) load(user); }, [user, load]);

  const run = (label, fn) => async () => {
    try {
      await fn();
      notify?.(`${label}: done. The ledger accepted it.`);
    } catch (e) {
      notify?.(`${label} rejected: ${e.message}`, "error");
    } finally {
      await load(user);
    }
  };

  if (user === undefined) return <p className="muted">Checking your session…</p>;
  if (!user) return <SignIn onSignedIn={setUser} />;

  const batches = workflow?.activeContracts?.redemptionBatches ?? [];
  const approvals = workflow?.activeContracts?.roleApprovals ?? [];
  const proposals = (workflow?.proposals ?? []).filter((p) => ["FinalizeRedemption", "FinalizePolicyRedemption", "UpdateFundPolicy"].includes(p.label));
  const myApprovalRoles = roles.filter((role) => APPROVAL_ROLES[role]);
  const writesOff = health && health.writesEnabled === false;

  return (
    <div className="live-ledger">
      <section className="card live-account">
        <div>
          <strong>{user.username}</strong>
          <span className="muted"> · acting as party <code title={user.party}>{short(user.party)}</code></span>
          <div className="live-roles">{roles.map((role) => <span key={role} className="badge">{APPROVAL_ROLES[role] ?? role}</span>)}</div>
        </div>
        <div className="live-account-actions">
          <button type="button" className="button quiet" onClick={() => load(user)}><RefreshCw size={14} /> Refresh</button>
          <button type="button" className="button quiet" onClick={async () => { await signOut(); setUser(null); setWorkflow(null); setRecords(null); }}><LogOut size={14} /> Sign out</button>
        </div>
      </section>
      {writesOff && <p className="live-banner" role="status">Ledger writes are disabled on this deployment. You can read, but actions will be refused.</p>}
      {loadError && <p className="live-error" role="alert">{loadError}</p>}

      {isInvestor && records && (
        <section className="card">
          <h2><Wallet size={18} /> My redemption records</h2>
          <p className="muted">Only you can see these. Acknowledging or withdrawing is recorded once; it is a demo acknowledgment, not a payment.</p>
          {records.entitlements.length + records.outstanding.length === 0 && <p className="muted">No open records.</p>}
          {records.entitlements.map((r) => (
            <div className="live-row" key={r.contractId}>
              <span>Allocated <strong>{units(r.units)}</strong> units · {r.batchId}</span>
              <Action label="Acknowledge" tone="primary" disabled={writesOff} onRun={run("Acknowledgment", () => api.acknowledge(r.contractId))} />
            </div>
          ))}
          {records.outstanding.map((r) => (
            <div className="live-row" key={r.contractId}>
              <span>Outstanding <strong>{units(r.units)}</strong> units · {r.batchId}</span>
              <Action label="Withdraw" disabled={writesOff} onRun={run("Withdrawal", () => api.withdraw(r.contractId))} />
            </div>
          ))}
          {[...records.receipts, ...records.releases].length > 0 && (
            <>
              <h3>Receipts</h3>
              {[...records.receipts, ...records.releases].map((r) => (
                <div className="live-row" key={r.contractId}>
                  <span><CheckCircle2 size={14} /> {units(r.units)} units · {r.batchId} · demo acknowledgment</span>
                </div>
              ))}
            </>
          )}
        </section>
      )}

      {!isInvestor && (
        <section className="card">
          <h2><ShieldCheck size={18} /> Batches</h2>
          {batches.length === 0 && <p className="muted">No active batches on the ledger.</p>}
          {batches.map(({ contractId, data }) => {
            const batchApprovals = approvals.filter((a) => a.data?.target?.batchCid === contractId);
            const picks = selected[contractId] ?? [];
            return (
              <article className="live-batch" key={contractId}>
                <header>
                  <strong>{data?.batchId}</strong>
                  <span className="muted"> · {units(data?.totalAllocated)} of {units(data?.totalRequested)} units funded · {data?.policyVersion}</span>
                </header>
                <ul className="live-approvals">
                  {batchApprovals.length === 0 && <li className="muted">No approvals yet.</li>}
                  {batchApprovals.map((a) => (
                    <li key={a.contractId}>
                      {roles.includes("Operator") && (
                        <input
                          type="checkbox"
                          aria-label={`Include ${APPROVAL_ROLES[a.data?.role] ?? a.data?.role} approval`}
                          checked={picks.includes(a.contractId)}
                          onChange={(e) => setSelected((s) => ({
                            ...s,
                            [contractId]: e.target.checked ? [...picks, a.contractId] : picks.filter((id) => id !== a.contractId),
                          }))}
                        />
                      )}
                      {APPROVAL_ROLES[a.data?.role] ?? a.data?.role} · <code title={a.data?.reviewer}>{short(a.data?.reviewer)}</code>
                    </li>
                  ))}
                </ul>
                <div className="live-actions">
                  {myApprovalRoles.map((role) => (
                    <Action key={role} label={`Approve as ${APPROVAL_ROLES[role]}`} tone="primary" disabled={writesOff}
                      onRun={run(`${APPROVAL_ROLES[role]} approval`, () => api.approve(contractId, role))} />
                  ))}
                  {roles.includes("Operator") && (
                    <Action label={`Propose finalization (${picks.length} approvals)`} disabled={writesOff || picks.length === 0}
                      onRun={run("Finalization proposal", async () => { await api.proposeFinalize(contractId, picks); setSelected((s) => ({ ...s, [contractId]: [] })); })} />
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}

      {myApprovalRoles.length > 0 && records?.approvals?.length > 0 && (
        <section className="card">
          <h2>My approvals</h2>
          {records.approvals.map((a) => (
            <div className="live-row" key={a.contractId}>
              <span>{APPROVAL_ROLES[a.role] ?? a.role} · {a.batchId}</span>
              <Action label="Revoke" disabled={writesOff} confirmText="Revoke this approval? The batch will need a new approval from your role."
                onRun={run("Revocation", () => api.revoke(a.contractId))} />
            </div>
          ))}
        </section>
      )}

      {roles.includes("GovernanceMember") && (
        <section className="card">
          <h2>BitSafe governance</h2>
          <p className="muted">Threshold {workflow?.threshold ?? "—"}. Confirm or execute from your own node.</p>
          {proposals.length === 0 && <p className="muted">No pending Alluvren proposals.</p>}
          {proposals.map((p) => (
            <div className="live-row" key={p.proposalCid}>
              <span><strong>{p.label}</strong> · {p.description} · {p.confirmationCount}/{workflow?.threshold ?? "?"} confirmations</span>
              <span className="live-actions">
                <Action label="Confirm" disabled={writesOff} onRun={run("Confirmation", () => api.confirm(p.proposalCid))} />
                <Action label="Execute" tone="primary" disabled={writesOff || !p.canExecute}
                  confirmText="Execute this governed action on the ledger? This cannot be undone."
                  onRun={run("Execution", () => api.execute(p.proposalCid))} />
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
