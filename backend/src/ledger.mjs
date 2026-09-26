import { randomUUID } from "node:crypto";

// Minimal Canton JSON Ledger API v2 client. The token stays server-side; callers
// pass actAs explicitly and the HTTP layer only ever passes the session party.
//
// baseUrl may list several participants (comma-separated), in order of
// preference; a party may be hosted on only some of them. Participants that
// report no connected synchronizer are tried last: a disconnected participant
// still answers reads, but from a stale ledger. Reads move to the next
// participant on any connection or server failure. A submission moves on only
// when the failure shows the command never reached the ledger: the participant
// was unreachable, answered that it is not connected to a synchronizer, or
// refused the party (403, it is hosted elsewhere). Rejections and timeouts are
// never retried elsewhere, so a command cannot be applied twice.

const TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_TTL_MS = 5000;
const NOT_SUBMITTED = /NOT_CONNECTED_TO_ANY_SYNCHRONIZER|SYNCHRONIZER_NOT_CONNECTED|NOT_CONNECTED_TO_SYNCHRONIZER|NO_SYNCHRONIZER_ON_WHICH_ALL_SUBMITTERS_CAN_SUBMIT|PARTICIPANT_IS_NOT_ACTIVE/;
const UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]);

export function createLedger({ baseUrl, token, userId = "ledger-api-user" }) {
  const endpoints = String(baseUrl || "").split(",").map((value) => value.trim()).filter(Boolean);
  const configured = Boolean(endpoints.length && token);

  async function call(endpoint, path, body, timeoutMs = TIMEOUT_MS) {
    if (!configured) throw Object.assign(new Error("Ledger API is not configured"), { status: 503 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(new URL(path, endpoint), {
        method: body === undefined ? "GET" : "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === "AbortError") throw Object.assign(new Error("Ledger outcome unknown"), { status: 504, unknownOutcome: true });
      const code = error.cause?.code;
      throw Object.assign(new Error("Ledger participant unreachable"), { status: 502, notSubmitted: UNREACHABLE.has(code), unreachable: true });
    }
    try {
      const text = await response.text();
      let parsed = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
      if (!response.ok) {
        throw Object.assign(new Error("Ledger rejected the request"), {
          status: response.status, ledgerReason: damlReason(text), serverError: response.status >= 500,
          // 403: this participant's user may not act or read for the party
          // (it is hosted elsewhere); refused before any processing.
          notSubmitted: NOT_SUBMITTED.test(text) || response.status === 403,
        });
      }
      return parsed;
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(new Error("Ledger outcome unknown"), { status: 504, unknownOutcome: true });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const health = new Map();
  async function connected(endpoint) {
    const cached = health.get(endpoint);
    if (cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.ok;
    let ok = false;
    try {
      const state = await call(endpoint, "/v2/state/connected-synchronizers", undefined, HEALTH_TIMEOUT_MS);
      ok = Array.isArray(state?.connectedSynchronizers) && state.connectedSynchronizers.length > 0;
    } catch {
      ok = false;
    }
    health.set(endpoint, { ok, at: Date.now() });
    return ok;
  }
  // Connected participants first, each group in configured order.
  async function ordered() {
    if (endpoints.length < 2) return endpoints.length ? endpoints : [""];
    const up = await Promise.all(endpoints.map(connected));
    return [...endpoints.filter((_, i) => up[i]), ...endpoints.filter((_, i) => !up[i])];
  }

  // Runs fn(endpoint) on each participant in turn while shouldRetry(error) holds.
  async function withFailover(fn, shouldRetry) {
    let lastError;
    for (const endpoint of await ordered()) {
      try {
        return await fn(endpoint);
      } catch (error) {
        lastError = error;
        health.delete(endpoint);
        if (!shouldRetry(error)) throw error;
      }
    }
    throw lastError;
  }
  const readRetry = (error) => Boolean(error.unreachable || error.serverError || error.notSubmitted || error.unknownOutcome);
  const submitRetry = (error) => Boolean(error.notSubmitted);

  // Submits one transaction for exactly the given acting party.
  async function submit(actAsParty, commands) {
    const commandId = `alluvren-${randomUUID()}`;
    const result = await withFailover((endpoint) => call(endpoint, "/v2/commands/submit-and-wait-for-transaction", {
      commands: { userId, commandId, actAs: [actAsParty], commands },
    }), submitRetry);
    const events = Array.isArray(result?.transaction?.events) ? result.transaction.events : [];
    return {
      updateId: result?.transaction?.updateId ?? null,
      created: events.map((event) => event?.CreatedEvent).filter(Boolean).map((event) => ({ templateId: event.templateId, contractId: event.contractId })),
    };
  }

  // Active contracts visible to exactly one party. Offsets belong to one
  // participant, so the ledger end and the snapshot come from the same one.
  async function activeContracts(party) {
    const response = await withFailover(async (endpoint) => {
      const end = await call(endpoint, "/v2/state/ledger-end");
      return call(endpoint, "/v2/state/active-contracts", {
        filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } },
        verbose: false,
        activeAtOffset: end.offset,
      });
    }, readRetry);
    return createdEvents(response)
      .map((event) => ({ templateId: String(event.templateId), contractId: event.contractId, argument: event.createArgument ?? {} }));
  }

  return { configured, submit, activeContracts };
}

// The active-contracts response nests createdEvent under a wrapper whose shape
// varies by Canton version; the LocalNet harnesses match it the same way.
function createdEvents(value, found = []) {
  if (Array.isArray(value)) value.forEach((item) => createdEvents(item, found));
  else if (value && typeof value === "object") {
    if (value.createdEvent && typeof value.createdEvent.contractId === "string") found.push(value.createdEvent);
    else Object.values(value).forEach((item) => createdEvents(item, found));
  }
  return found;
}

// Only surface the Daml requirement text, never raw ledger payloads.
export function damlReason(text) {
  const match = /The requirement '([^']{1,200})' was not met/.exec(String(text))
    ?? /(Missing required approvals for role [A-Za-z]{1,40})/.exec(String(text));
  return match ? match[1] : null;
}

export function templateName(templateId) {
  return String(templateId).split(":").pop();
}
