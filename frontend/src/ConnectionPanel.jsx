import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  RefreshCw,
  X,
} from "lucide-react";

function issueFor(error) {
  const code = error.status;
  if (code === 401)
    return {
      title: "Authentication required",
      reason: "The service requires a valid session.",
      action: "Restore your backend session, then check access again.",
    };
  if (code === 403)
    return {
      title: "Read access denied",
      reason: "The service refused access to governance evidence.",
      action: "Ask your operator to grant read access, then retry.",
    };
  if (error.name === "TimeoutError")
    return {
      title: "Connection timed out",
      reason: "The service did not respond within 10 seconds.",
      action: "Check the service connection, then retry.",
    };
  if (error.invalid)
    return {
      title: "Evidence could not be read",
      reason: "The service returned an unexpected response.",
      action: "Ask your operator to check the service, then retry.",
    };
  return {
    title: "Service unavailable",
    reason: code
      ? `The service could not complete this request (HTTP ${code}).`
      : "The connection could not be completed. The cause is not confirmed.",
    action:
      "Check that the service is available, then retry. You can continue using the demo.",
  };
}

function shortId(value = "") {
  return value.length > 28 ? `${value.slice(0, 13)}…${value.slice(-10)}` : value;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Time unavailable";
  return new Date(seconds * 1000).toLocaleString();
}

function formatLedgerTime(micros) {
  if (!Number.isSafeInteger(micros) || micros <= 0) return "Time unavailable";
  return new Date(micros / 1000).toLocaleString();
}

async function getJson(path, signal) {
  const base = (import.meta.env.VITE_ALLUVREN_API_URL || "").replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok)
    throw Object.assign(new Error("Request failed"), {
      status: response.status,
      path,
    });
  try {
    return await response.json();
  } catch {
    throw Object.assign(new Error("Invalid response"), { invalid: true, path });
  }
}

export function useGovernanceEvidence(notify) {
  const [connection, setConnection] = useState({
    phase: "idle",
    snapshot: null,
    issue: null,
  });
  const pending = useRef(null);
  useEffect(() => () => pending.current?.abort(), []);
  const checkConnection = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setConnection((c) => ({ ...c, phase: "loading", issue: null }));
    try {
      let health, workflow;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          health = await getJson("/healthz", controller.signal);
          if (
            !health ||
            health.ok !== true ||
            !Array.isArray(health.nodes) ||
            health.nodes.some((n) => !n || typeof n.ok !== "boolean") ||
            typeof health.environment !== "string"
          )
            throw Object.assign(new Error("Invalid health"), {
              invalid: true,
              path: "/healthz",
            });
          workflow = await getJson("/api/workflow", controller.signal);
          if (
            !workflow ||
            !Array.isArray(workflow.proposals) ||
            !workflow.activeContracts ||
            !Array.isArray(workflow.activeContracts.redemptionBatches) ||
            !Array.isArray(workflow.activeContracts.roleApprovals) ||
            [...workflow.activeContracts.redemptionBatches, ...workflow.activeContracts.roleApprovals].some((contract) => !contract || typeof contract.contractId !== "string" || (contract.data !== null && typeof contract.data !== "object")) ||
            workflow.proposals.some((proposal) => !Array.isArray(proposal.confirmations)) ||
            !Array.isArray(workflow.audit)
          )
            throw Object.assign(new Error("Invalid evidence"), {
              invalid: true,
              path: "/api/workflow",
            });
          break;
        } catch (error) {
          if (
            controller.signal.aborted ||
            attempt === 1 ||
            error.invalid ||
            (error.status && error.status < 500)
          )
            throw error;
          notify("Connection interrupted. Retrying once…", "info");
          // Only idempotent reads are retried. Cancellation interrupts the backoff.
          await new Promise((resolve, reject) => {
            const cancel = () => {
              clearTimeout(timer);
              reject(new DOMException("Cancelled", "AbortError"));
            };
            const timer = setTimeout(() => {
              controller.signal.removeEventListener("abort", cancel);
              resolve();
            }, 800);
            controller.signal.addEventListener("abort", cancel, { once: true });
          });
        }
      }
      if (!controller.signal.aborted) {
        setConnection({
          phase: "connected",
          snapshot: { health, workflow, updatedAt: new Date().toISOString() },
          issue: null,
        });
        notify("Governance evidence updated", "success");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setConnection((c) => ({
          ...c,
          phase: "error",
          issue: {
            ...issueFor(error),
            path: error.path || "Connection",
            code: error.status || error.name,
          },
        }));
        notify(
          "Evidence unavailable. Connection details include recovery steps.",
          "error",
        );
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  const cancelConnection = () => {
    pending.current?.abort();
    pending.current = null;
    setConnection((c) => ({
      ...c,
      phase: c.snapshot ? "stale" : "idle",
      issue: c.snapshot
        ? {
            title: "Refresh cancelled",
            reason: "Showing the last successful snapshot.",
            action: "Refresh when you are ready.",
          }
        : null,
    }));
  };
  return { connection, checkConnection, cancelConnection };
}

export function ConnectionPanel({ connection, onRefresh, onCancel }) {
  const { phase, snapshot, issue } = connection;
  const loading = phase === "loading";
  const stale = snapshot && ["error", "stale"].includes(phase);
  const workflow = snapshot?.workflow;
  return (
    <section className="connection-panel" aria-label="Governance evidence">
      <p className="modal-copy">
        Read-only governance evidence. Demo actions stay in this workspace.
      </p>
      <div
        className={`connection-status ${phase === "connected" ? "sage-text" : issue ? "gold-text" : ""}`}
        role="status"
      >
        {phase === "connected" ? (
          <CheckCircle2 size={17} />
        ) : issue ? (
          <AlertTriangle size={17} />
        ) : (
          <Database size={17} />
        )}
        <strong>
          {loading
            ? snapshot
              ? "Refreshing evidence…"
              : "Loading evidence…"
            : stale
              ? "Showing saved evidence"
              : phase === "connected"
                ? "Connected, read-only"
                : phase === "error"
                  ? issue.title
                  : "Not connected"}
        </strong>
      </div>
      {issue && (
        <div
          className={`connection-issue ${snapshot ? "warning" : "danger"}`}
          role="alert"
        >
          {snapshot && <strong>{issue.title}</strong>}
          <p>{issue.reason}</p>
          <p>{issue.action}</p>
          {issue.code && (
            <details>
              <summary>Technical details</summary>
              <p>
                {issue.path} · {issue.code}
              </p>
            </details>
          )}
        </div>
      )}
      <div aria-busy={loading} aria-label="Evidence content">
        {loading && !snapshot && (
          <div
            className="evidence-skeleton"
            data-testid="evidence-skeleton"
            aria-hidden="true"
          >
            <div className="skeleton skeleton-title" />
            <div className="skeleton-row">
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line short" />
          </div>
        )}
        {snapshot && (
          <>
            <dl className="detail-list">
              <div>
                <dt>Environment</dt>
                <dd>{snapshot.health.environment}</dd>
              </div>
              <div>
                <dt>Nodes available</dt>
                <dd>
                  {snapshot.health.nodes.filter((n) => n.ok).length} /{" "}
                  {snapshot.health.nodes.length}
                </dd>
              </div>
            </dl>
            <p className="snapshot-time">
              {stale ? "Last successful update" : "Updated"}{" "}
              <time dateTime={snapshot.updatedAt}>
                {new Date(snapshot.updatedAt).toLocaleString()}
              </time>
            </p>
            {workflow.proposals.length === 0 &&
            workflow.audit.length === 0 ? (
              <div className="evidence-empty">
                <Database size={24} />
                <h3>No governance activity yet</h3>
                <p>
                  Proposals, member confirmations and execution records will
                  appear here after activity is recorded for the configured
                  governance party.
                </p>
                <p>
                  Submit a proposal through your operator’s governance workflow,
                  then refresh this view.
                </p>
              </div>
            ) : (
              <dl className="evidence-counts">
                <div>
                  <dt>Open proposals</dt>
                  <dd>{workflow.proposals.length}</dd>
                </div>
                <div>
                  <dt>Member threshold</dt>
                  <dd>{workflow.threshold ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Recent ledger events</dt>
                  <dd>{workflow.audit.length}</dd>
                </div>
              </dl>
            )}
            {workflow.activeContracts.configured ? (
              <section className="live-evidence-section" aria-label="Active Alluvren contracts">
                <h3>Active Alluvren contracts</h3>
                <div className="evidence-counts">
                  <div><dt>Redemption batches</dt><dd>{workflow.activeContracts.redemptionBatches.length}</dd></div>
                  <div><dt>Role approvals</dt><dd>{workflow.activeContracts.roleApprovals.length}</dd></div>
                </div>
                <div className="alluvren-contract-list">
                  {workflow.activeContracts.redemptionBatches.map((batch) => (
                    <article className="alluvren-contract" key={batch.contractId}>
                      <div className="alluvren-contract-heading">
                        <div><span className="eyebrow">REDEMPTION BATCH</span><h4>{batch.data?.batchId || "Batch details unavailable"}</h4></div>
                        <code title={batch.contractId}>{shortId(batch.contractId)}</code>
                      </div>
                      {batch.data ? (
                        <>
                          <dl className="batch-summary">
                            <div><dt>Policy</dt><dd>{batch.data.policyVersion || "Unavailable"}</dd></div>
                            <div><dt>Requested</dt><dd>{batch.data.totalRequested ?? "Unavailable"}</dd></div>
                            <div><dt>Allocated</dt><dd>{batch.data.totalAllocated ?? "Unavailable"}</dd></div>
                            <div><dt>Review deadline</dt><dd>{formatLedgerTime(batch.data.recoveryDeadline)}</dd></div>
                          </dl>
                          {batch.data.rows.length > 0 && (
                            <div className="allocation-table-wrap">
                              <table className="allocation-table">
                                <thead><tr><th>Request</th><th>Investor</th><th>Requested</th><th>Allocated</th></tr></thead>
                                <tbody>{batch.data.rows.map((row, index) => (
                                  <tr key={`${row.requestId || "row"}-${index}`}>
                                    <td>{row.requestId || "Unavailable"}</td><td>{row.investor ? shortId(row.investor) : "Unavailable"}</td>
                                    <td>{row.requestedUnits ?? "Unavailable"}</td><td>{row.allocatedUnits ?? "Unavailable"}</td>
                                  </tr>
                                ))}</tbody>
                              </table>
                            </div>
                          )}
                        </>
                      ) : <p className="evidence-note">The ledger returned this contract, but its fields could not be interpreted.</p>}
                    </article>
                  ))}
                </div>
                <div className="alluvren-approval-list">
                  {workflow.activeContracts.roleApprovals.map((approval) => (
                    <article className="alluvren-approval" key={approval.contractId}>
                      <div><strong>{approval.data?.role || "Role approval"}</strong><span>{approval.data?.reviewer ? shortId(approval.data.reviewer) : "Reviewer unavailable"}</span></div>
                      <p>For batch {approval.data?.target?.batchId || "unavailable"} · expires {formatLedgerTime(approval.data?.expiresAt)}</p>
                      <code title={approval.contractId}>{shortId(approval.contractId)}</code>
                    </article>
                  ))}
                </div>
              </section>
            ) : (
              <p className="evidence-note">Alluvren package ID is not configured, so active contract counts are unavailable.</p>
            )}
            <section className="live-evidence-section" aria-label="Live governance proposals">
              <h3>Governance proposals</h3>
              {workflow.proposals.length === 0 ? (
                <p className="evidence-note">No pending proposals are visible to this governance party.</p>
              ) : (
                <ul className="live-proposal-list">
                  {workflow.proposals.map((proposal) => (
                    <li className="live-proposal" key={proposal.proposalCid}>
                      <div className="live-proposal-heading">
                        <strong>{proposal.label || "Governance proposal"}</strong>
                        <span className={proposal.canExecute ? "sage-text" : proposal.orphaned ? "error-text" : "gold-text"}>
                          {proposal.orphaned ? "Proposal unavailable" : proposal.canExecute ? "Threshold met" : `${proposal.confirmationCount}/${workflow.threshold ?? "?"} confirmations`}
                        </span>
                      </div>
                      {proposal.description && <p>{proposal.description}</p>}
                      <code title={proposal.proposalCid}>{shortId(proposal.proposalCid)}</code>
                      {proposal.confirmations.length > 0 && (
                        <p className="evidence-note">Confirmed by {proposal.confirmations.map((item) => shortId(item.party)).join(", ")}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="live-evidence-section" aria-label="Recent ledger activity">
              <h3>Recent ledger activity</h3>
              {workflow.audit.length === 0 ? (
                <p className="evidence-note">No ledger events were returned for this party.</p>
              ) : (
                <ul className="live-audit-list">
                  {workflow.audit.slice(0, 8).map((event, index) => (
                    <li key={`${event.updateId}-${event.eventType}-${index}`}>
                      <span className={`audit-marker audit-${event.eventType}`} aria-hidden="true" />
                      <div>
                        <strong>{event.summary || event.details?.actionLabel || event.eventType}</strong>
                        <p>{formatTime(event.timestamp)} · {event.template || "Ledger event"}</p>
                        <code title={event.updateId}>{shortId(event.updateId)}</code>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
        {!snapshot && phase === "idle" && (
          <div className="evidence-empty">
            <Database size={24} />
            <h3>Connect to inspect governance</h3>
            <p>
              Load proposals, confirmations and audit records from your
              configured service.
            </p>
          </div>
        )}
      </div>
      <div className="connection-actions">
        <button
          className="button primary full"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? "spin" : ""} />
          {loading
            ? "Loading…"
            : snapshot
              ? "Refresh evidence"
              : issue
                ? "Retry connection"
                : "Check read-only connection"}
        </button>
        {loading && (
          <button className="button" onClick={onCancel}>
            <X size={14} />
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}
