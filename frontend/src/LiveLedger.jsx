import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Clock3, Layers3, LockKeyhole, LogOut, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { api, restoreSession, signIn, signOut } from "./api.js";
import { DEMO_VIDEO_URL, REPO_URL } from "./publicDemo.js";

const ROLE_LABELS = {
  FundReviewer: "Fund review",
  TreasuryReviewer: "Treasury",
  ComplianceReviewer: "Compliance",
  AdministratorCheck: "Administrator check",
  FinalSignoff: "COO final sign-off",
  Operator: "Operator",
  GovernanceMember: "BitSafe member",
  Investor: "Investor",
};
const ACTION_LABELS = {
  FinalizePolicyRedemption: "Finalize batch",
  FinalizeRedemption: "Finalize batch (two-reviewer)",
  UpdateFundPolicy: "Policy change",
};
const GOVERNED = Object.keys(ACTION_LABELS);

const roleLabel = (role) => ROLE_LABELS[role] ?? role;
const short = (value = "") => (value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value);
const units = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "—");
const pct = (bps) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : /(ch|sh|s|x)$/.test(word) ? "es" : "s"}`;

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
      <p className="live-lede">Your account decides which party you act as. Every action here is a real LocalNet ledger command.</p>
      <label htmlFor="live-username">Username</label>
      <input id="live-username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
      <label htmlFor="live-password">Password</label>
      <input id="live-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <p className="live-error" role="alert">{error}</p>}
      <button className="button primary" type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

// Runs its action once. A second click is ignored while it is in flight, and
// after the ledger accepts it the button stays disabled, showing doneLabel,
// until the data it acted on changes (callers key it by that data). A rejected
// action can be tried again. Optional confirmation for irreversible actions.
function Action({ label, doneLabel = "Done", onRun, disabled, tone = "", confirmText, title }) {
  const [state, setState] = useState("idle");
  const busy = useRef(false);
  return (
    <button
      type="button"
      className={`button ${tone}`}
      disabled={disabled || state !== "idle"}
      title={title}
      onClick={async () => {
        if (busy.current) return;
        if (confirmText && !window.confirm(confirmText)) return;
        busy.current = true;
        setState("pending");
        const ok = await onRun();
        setState(ok ? "done" : "idle");
        busy.current = ok;
      }}
    >
      {state === "pending" ? "Submitting…" : state === "done" ? doneLabel : label}
    </button>
  );
}

function Funding({ status, data }) {
  const funded = status?.fundedBps ?? (data?.totalRequested ? Math.floor((data.totalAllocated * 10000) / data.totalRequested) : 0);
  const threshold = status?.fundingThresholdBps ?? null;
  const below = threshold !== null && funded < threshold;
  return (
    <div className="funding">
      <div className="funding-track" role="img"
        aria-label={`Funded ${pct(funded)}${threshold !== null ? `; policy threshold ${pct(threshold)}` : ""}`}>
        <span className={`funding-fill ${below ? "below" : ""}`} style={{ width: `${Math.min(100, funded / 100)}%` }} />
        {threshold !== null && <span className="funding-marker" style={{ left: `${threshold / 100}%` }} />}
      </div>
      <div className="funding-legend">
        <span className="live-units">{units(data?.totalAllocated)} of {units(data?.totalRequested)} units funded · {pct(funded)}</span>
        {threshold !== null && <span>{below ? `Below the ${pct(threshold)} line: extra sign-off required` : `At or above the ${pct(threshold)} line`}</span>}
      </div>
    </div>
  );
}

function focusLines({ roles, user, statuses, batches, proposals, records, sealedPending }) {
  const lines = [];
  if (roles.includes("Investor") && records) {
    const toAck = records.entitlements.reduce((s, r) => s + r.units, 0);
    const out = records.outstanding.reduce((s, r) => s + r.units, 0);
    if (toAck) lines.push(<>You have <strong>{units(toAck)} units</strong> to acknowledge</>);
    if (out) lines.push(<><strong>{units(out)} units</strong> were not funded and can be withdrawn</>);
  }
  for (const role of roles.filter((r) => ["FundReviewer", "TreasuryReviewer", "ComplianceReviewer", "AdministratorCheck", "FinalSignoff"].includes(r))) {
    const waiting = batches.filter(({ contractId }) => {
      const row = statuses[contractId]?.roles.find((r) => r.role === role);
      return row && !row.met && row.members.includes(user.party) && !row.approvals.some((a) => a.reviewer === user.party);
    }).length;
    if (waiting) lines.push(<><strong>{plural(waiting, "batch")}</strong> {waiting === 1 ? "needs" : "need"} your {roleLabel(role)} approval</>);
  }
  if (roles.includes("Operator")) {
    const ready = batches.filter(({ contractId }) => statuses[contractId]?.complete).length;
    if (ready) lines.push(<><strong>{plural(ready, "batch")}</strong> {ready === 1 ? "has" : "have"} every required approval and can be proposed</>);
    if (sealedPending.length) lines.push(<><strong>{plural(sealedPending.length, "sealed batch")}</strong> {sealedPending.length === 1 ? "is" : "are"} finalized and ready to distribute</>);
  }
  if (roles.includes("GovernanceMember")) {
    const toConfirm = proposals.filter((p) => !p.confirmations?.some((c) => c.party === user.party)).length;
    const toExecute = proposals.filter((p) => p.canExecute).length;
    if (toConfirm) lines.push(<><strong>{plural(toConfirm, "proposal")}</strong> {toConfirm === 1 ? "awaits" : "await"} your confirmation</>);
    if (toExecute) lines.push(<><strong>{plural(toExecute, "proposal")}</strong> {toExecute === 1 ? "is" : "are"} ready to execute</>);
  }
  return lines;
}

// Shown instead of the Live ledger on public builds, which have no LocalNet.
export function LiveLedgerNotice() {
  return (
    <section className="card live-notice">
      <h2><ShieldCheck size={18} /> The live ledger runs on BitSafe LocalNet</h2>
      <p className="live-lede">
        Every action on this tab is a real Daml command on a three-node BitSafe LocalNet, so it runs next to the nodes rather than on this public site.
        The walkthrough tabs show the same product with simulated data.
      </p>
      <div className="live-actions">
        {DEMO_VIDEO_URL && <a className="button primary" href={DEMO_VIDEO_URL} target="_blank" rel="noreferrer">Watch the live demo</a>}
        <a className={`button ${DEMO_VIDEO_URL ? "" : "primary"}`} href={`${REPO_URL}/blob/main/REPRODUCE.md`} target="_blank" rel="noreferrer">Run it yourself</a>
        <a className="button quiet" href={REPO_URL} target="_blank" rel="noreferrer">Source on GitHub</a>
      </div>
    </section>
  );
}

export function LiveLedger({ notify, headerSlotId = "live-header-slot" }) {
  const [user, setUser] = useState(undefined);
  const [health, setHealth] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [records, setRecords] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [slot, setSlot] = useState(null);

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

  useEffect(() => { setSlot(document.getElementById(headerSlotId)); }, [headerSlotId]);
  useEffect(() => { restoreSession().then(setUser).catch(() => setUser(null)); }, []);
  useEffect(() => { if (user) load(user); }, [user, load]);
  // Keep counts current while the page is open: approvals, proposals and
  // expiries change from other people's screens.
  useEffect(() => {
    if (!user) return undefined;
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(user); }, 20000);
    return () => clearInterval(timer);
  }, [user, load]);

  // Resolves true when the ledger accepted the action, false when it was rejected.
  const run = (label, fn, describe) => async () => {
    try {
      const result = await fn();
      notify?.(`${describe ? describe(result) : label}: done. The ledger accepted it.`);
      return true;
    } catch (e) {
      notify?.(`${label} rejected: ${e.message}`, "error");
      return false;
    } finally {
      await load(user);
    }
  };
  const doSignOut = async () => {
    await signOut();
    setUser(null);
    setWorkflow(null);
    setRecords(null);
  };

  const header = slot && createPortal(
    user ? (
      <>
        <span className="env-chip">LocalNet</span>
        <span className="initials" aria-hidden="true">{user.username.slice(0, 2).toUpperCase()}</span>
        <span className="who"><strong>{user.username}</strong><small>{roles.map(roleLabel).join(" · ")}</small></span>
        <button type="button" className="button quiet" onClick={doSignOut} aria-label="Sign out"><LogOut size={14} /> <span className="label">Sign out</span></button>
      </>
    ) : <span className="env-chip">LocalNet</span>,
    slot,
  );

  if (user === undefined) return <>{header}<p className="live-lede">Checking your session…</p></>;
  if (!user) return <>{header}<SignIn onSignedIn={setUser} /></>;

  const batches = workflow?.activeContracts?.redemptionBatches ?? [];
  const approvals = workflow?.activeContracts?.roleApprovals ?? [];
  const statuses = workflow?.batchStatus ?? {};
  const proposals = (workflow?.proposals ?? []).filter((p) => GOVERNED.includes(p.label));
  const myApprovalRoles = roles.filter((role) => ["FundReviewer", "TreasuryReviewer", "ComplianceReviewer", "AdministratorCheck", "FinalSignoff"].includes(role));
  const myApprovals = records?.approvals ?? [];
  const writesOff = health && health.writesEnabled === false;
  // Sealed batches finalized by governance whose rows the operator still has to open.
  const sealedPending = roles.includes("Operator")
    ? (workflow?.activeContracts?.sealedFinalizations ?? []).filter((f) => f.data?.operator === user.party)
    : [];
  const lines = focusLines({ roles, user, statuses, batches, proposals, records, sealedPending });
  const policies = [...new Set(Object.values(statuses).map((s) => s.policyVersion).filter(Boolean))];
  const investorBatches = isInvestor && records
    ? [...new Set([...records.entitlements, ...records.outstanding].map((r) => r.batchId))]
    : [];

  return (
    <>
      {header}
      <div className="live-layout">
        <div className="live-ledger">
          <div className={`live-focus ${lines.length ? "" : "clear"}`} role="status">
            <span>{lines.length ? lines.map((line, i) => <span key={i}>{i > 0 ? " · " : ""}{line}</span>) : "Nothing is waiting for you right now."}</span>
            <button type="button" className="button quiet" onClick={() => load(user)} style={{ marginLeft: "auto" }}><RefreshCw size={14} /> Refresh</button>
          </div>
          {writesOff && <p className="live-banner" role="status">Ledger writes are disabled on this deployment. You can read, but actions will be refused.</p>}
          {loadError && <p className="live-error" role="alert">{loadError}</p>}

          {isInvestor && records && (
            <section className="card">
              <h2><Wallet size={18} /> My redemption records</h2>
              <p className="live-lede">Other investors can't see these. Each action is recorded once; it is a demo acknowledgment, not a payment.</p>
              {investorBatches.length === 0 && <p className="live-lede">No open records.</p>}
              {investorBatches.map((batchId) => (
                <div key={batchId}>
                  <h3>{batchId}</h3>
                  {records.entitlements.filter((r) => r.batchId === batchId).map((r) => (
                    <div className="live-row" key={r.contractId}>
                      <span>Allocated <strong className="live-units">{units(r.units)}</strong> units{r.sealed && <span className="sealed-tag" title="From a sealed batch: governance nodes never saw this row">sealed</span>}</span>
                      <Action label="Acknowledge" doneLabel="Acknowledged" tone="primary" disabled={writesOff} onRun={run("Acknowledgment", () => api.acknowledge(r.contractId))} />
                    </div>
                  ))}
                  {records.outstanding.filter((r) => r.batchId === batchId).map((r) => (
                    <div className="live-row" key={r.contractId}>
                      <span>Not funded <strong className="live-units">{units(r.units)}</strong> units{r.sealed && <span className="sealed-tag" title="From a sealed batch: governance nodes never saw this row">sealed</span>}</span>
                      <Action label="Withdraw" doneLabel="Withdrawn" disabled={writesOff} onRun={run("Withdrawal", () => api.withdraw(r.contractId))} />
                    </div>
                  ))}
                </div>
              ))}
              {[...records.receipts, ...records.releases].length > 0 && (
                <>
                  <h3>Receipts</h3>
                  {records.receipts.map((r) => (
                    <div className="live-row" key={r.contractId}><span><CheckCircle2 size={14} /> Acknowledged {units(r.units)} units · {r.batchId}</span></div>
                  ))}
                  {records.releases.map((r) => (
                    <div className="live-row" key={r.contractId}><span><CheckCircle2 size={14} /> Withdrew {units(r.units)} units · {r.batchId}</span></div>
                  ))}
                </>
              )}
            </section>
          )}

          {!isInvestor && (
            <section className="card">
              <h2><Layers3 size={18} /> Batches</h2>
              {batches.length === 0 && <p className="live-lede">No active batches on the ledger.</p>}
              {batches.map(({ contractId, data }) => {
                const status = statuses[contractId];
                const validCids = status ? status.roles.flatMap((r) => r.approvals.map((a) => a.approvalCid)) : [];
                const missing = status ? status.roles.filter((r) => !r.met).map((r) => roleLabel(r.role)) : [];
                return (
                  <article className="live-batch" key={contractId}>
                    <div className="live-batch-head">
                      <strong>{data?.batchId}</strong>
                      <span className="live-meta"><span className="nowrap">{data?.policyVersion}</span>{status?.kind === "legacy" ? " · two-reviewer rule" : ""}</span>
                    </div>
                    <Funding status={status} data={data} />
                    {data?.sealed && (
                      <p className="sealed-note">
                        <LockKeyhole size={14} /> Rows sealed: {plural(data.sealed.rowCount ?? 0, "request")}, largest allocation {units(data.sealed.maxRowAllocatedUnits)} units.
                        {" "}Governance sees totals and a commitment, not who gets what: <code title={data.sealed.commitment ?? ""}>{short(data.sealed.commitment ?? "")}</code>
                      </p>
                    )}
                    {status && status.policyVisible ? (
                      <ul className="checklist" aria-label={`Required approvals for ${data?.batchId}`}>
                        {status.roles.map((row) => {
                          const mine = myApprovalRoles.includes(row.role) && row.members.includes(user.party);
                          const myApproval = myApprovals.find((a) => a.batchCid === contractId && a.role === row.role);
                          return (
                            <li className="check-row" key={row.role}>
                              {row.met
                                ? <CheckCircle2 size={18} className="check-icon met" aria-label="Met" />
                                : <Clock3 size={18} className="check-icon wait" aria-label="Waiting" />}
                              <span>
                                <span className="check-role">{roleLabel(row.role)}</span>{" "}
                                <span className="check-detail">{row.approvals.length} of {row.quorum}{row.quorum > 1 ? " required" : ""}</span>
                                {row.conditional && <><br /><span className="check-reason">Required because {row.reasons.join(" and ")}</span></>}
                              </span>
                              <span className="live-actions">
                                {mine && (myApproval ? (
                                  <>
                                    <span className="approved-tag"><CheckCircle2 size={14} /> You approved</span>
                                    <Action key={myApproval.contractId} label="Revoke" doneLabel="Revoked" tone="quiet" disabled={writesOff}
                                      confirmText="Revoke this approval? The batch will need a new approval from your role."
                                      onRun={run("Revocation", () => api.revoke(myApproval.contractId))} />
                                  </>
                                ) : (
                                  <Action label="Approve" doneLabel="Approved" tone="primary" disabled={writesOff}
                                    onRun={run(`${roleLabel(row.role)} approval`, () => api.approve(contractId, row.role))} />
                                ))}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="live-lede">
                        {status ? "This batch's policy is not visible to your account, so requirements can't be shown." : "Requirements are not available for this batch."}
                        {" "}{approvals.filter((a) => a.data?.target?.batchCid === contractId).length} approvals on record.
                      </p>
                    )}
                    {roles.includes("Operator") && status && (
                      <div className="live-actions">
                        {/* Keyed by the approval set: a new or expired approval gives a fresh button. */}
                        <Action
                          key={validCids.join(",")}
                          label={status.currentProposed ? "Proposed" : `Propose with ${plural(validCids.length, "approval")}`}
                          doneLabel="Proposed"
                          tone={status.complete && !status.currentProposed ? "primary" : ""}
                          disabled={writesOff || validCids.length === 0 || status.kind === "legacy" || status.currentProposed}
                          title={status.kind === "legacy" ? "Two-reviewer batches are finalized through the operator runbook" : undefined}
                          onRun={run("Finalization proposal", () => api.proposeFinalize(contractId),
                            (r) => `Finalization proposal with ${plural(r?.approvalCount ?? validCids.length, "approval")}`)}
                        />
                        {status.currentProposed ? (
                          <p className="live-hint">A proposal with these {plural(validCids.length, "approval")} is open. BitSafe members confirm it from their own nodes.</p>
                        ) : !status.complete && validCids.length > 0 && (
                          <p className="live-hint">Still missing {missing.join(", ")}. BitSafe will reject execution until every requirement is met.</p>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </section>
          )}

          {sealedPending.length > 0 && (
            <section className="card">
              <h2><LockKeyhole size={18} /> Sealed batches to distribute</h2>
              <p className="live-lede">Governance finalized these without seeing their rows. Opening the allocation book checks the rows against the approved commitment, then issues each investor a private record.</p>
              {sealedPending.map(({ contractId, data }) => (
                <div className="live-row" key={contractId}>
                  <span><strong>{data?.batchId}</strong> · {units(data?.totalAllocated)} units across {plural(data?.sealed?.rowCount ?? 0, "request")}</span>
                  <Action label="Open allocation book" doneLabel="Opened" tone="primary" disabled={writesOff}
                    onRun={run("Distribution", () => api.distributeSealed(contractId))} />
                </div>
              ))}
            </section>
          )}

          {roles.includes("GovernanceMember") && (
            <section className="card">
              <h2><ShieldCheck size={18} /> BitSafe governance</h2>
              <p className="live-lede">Confirm from your own node. A proposal executes once {workflow?.threshold ?? "the required number of"} members confirm; the ledger then re-checks every business rule.</p>
              {proposals.length === 0 && <p className="live-lede">No pending Alluvren proposals.</p>}
              {proposals.map((p) => {
                const confirmedByMe = p.confirmations?.some((c) => c.party === user.party);
                const threshold = workflow?.threshold ?? 0;
                return (
                  <div className="live-row" key={p.proposalCid}>
                    <span>
                      <strong>{ACTION_LABELS[p.label] ?? p.label}</strong>
                      <span className="live-meta"> · {p.description}</span><br />
                      <span className="progress" aria-label={`${p.confirmationCount} of ${threshold} confirmations`}>
                        {Array.from({ length: Math.max(threshold, p.confirmationCount) }, (_, i) => <i key={i} className={i < p.confirmationCount ? "on" : ""} />)}
                      </span>{" "}
                      <span className="live-meta">{p.confirmationCount} of {threshold} confirmations{confirmedByMe ? " · you confirmed" : ""}</span>
                    </span>
                    <span className="live-actions">
                      <Action label={confirmedByMe ? "Confirmed" : "Confirm"} doneLabel="Confirmed" disabled={writesOff || confirmedByMe}
                        onRun={run("Confirmation", () => api.confirm(p.proposalCid))} />
                      <Action label="Execute" doneLabel="Executed" tone="primary" disabled={writesOff || !p.canExecute}
                        title={p.canExecute ? undefined : `Needs ${threshold} of ${threshold} confirmations`}
                        confirmText="Execute this governed action on the ledger? This cannot be undone."
                        onRun={run("Execution", () => api.execute(p.proposalCid))} />
                    </span>
                  </div>
                );
              })}
            </section>
          )}
        </div>

        <aside className="live-context" aria-label="Ledger context">
          <h2>Context</h2>
          <dl>
            <div><dt>Environment</dt><dd>{health?.environment ?? "LocalNet"}</dd></div>
            <div><dt>Writes</dt><dd>{health ? (health.writesEnabled ? "Enabled" : "Disabled") : "Unknown"}</dd></div>
            {!isInvestor && <div><dt>BitSafe threshold</dt><dd>{workflow?.threshold ? `${workflow.threshold} member confirmations` : "—"}</dd></div>}
            {policies.length > 0 && <div><dt>Policies in force</dt><dd>{policies.map((p) => <code key={p}>{p} </code>)}</dd></div>}
            <div><dt>You act as</dt><dd><code title={user.party}>{short(user.party)}</code></dd></div>
          </dl>
          <p className="live-lede">Every action is a Daml command. The ledger re-checks every rule, so a stale view can't finalize the wrong batch.</p>
        </aside>
      </div>
    </>
  );
}
