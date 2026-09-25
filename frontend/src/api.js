// Browser client for the Alluvren backend. The session lives in an HttpOnly
// cookie; the CSRF token is kept in memory only (never in localStorage).

const base = (import.meta.env?.VITE_ALLUVREN_API_URL || "").replace(/\/$/, "");
let csrfToken = null;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    credentials: "include",
    signal: signal ?? AbortSignal.timeout(20000),
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" && csrfToken ? { "x-alluvren-csrf": csrfToken } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) throw new ApiError(typeof payload.error === "string" ? payload.error : `Request failed (HTTP ${response.status})`, response.status);
  return payload;
}

export async function signIn(username, password) {
  const result = await request("/api/auth/login", { method: "POST", body: { username, password } });
  csrfToken = result.csrfToken;
  return result.user;
}

export async function restoreSession() {
  try {
    const result = await request("/api/auth/me");
    csrfToken = result.csrfToken;
    return result.user;
  } catch (error) {
    if (error.status === 401) return null;
    throw error;
  }
}

export async function signOut() {
  try { await request("/api/auth/logout", { method: "POST", body: {} }); } finally { csrfToken = null; }
}

export const api = {
  health: () => request("/healthz"),
  workflow: () => request("/api/workflow"),
  myRecords: () => request("/api/me/records"),
  approve: (batchCid, role) => request("/api/approvals", { method: "POST", body: { batchCid, role } }),
  revoke: (approvalCid) => request("/api/approvals/revoke", { method: "POST", body: { approvalCid } }),
  acknowledge: (entitlementCid) => request("/api/claims/acknowledge", { method: "POST", body: { entitlementCid } }),
  withdraw: (outstandingCid) => request("/api/outstanding/withdraw", { method: "POST", body: { outstandingCid } }),
  proposeFinalize: (batchCid, approvalCids) => request("/api/proposals/finalize", { method: "POST", body: { batchCid, approvalCids } }),
  confirm: (proposalCid) => request("/api/governance/confirm", { method: "POST", body: { proposalCid } }),
  execute: (proposalCid) => request("/api/governance/execute", { method: "POST", body: { proposalCid } }),
};
