import { randomUUID } from "node:crypto";

// Minimal Canton JSON Ledger API v2 client. The token stays server-side; callers
// pass actAs explicitly and the HTTP layer only ever passes the session party.

const TIMEOUT_MS = 15000;

export function createLedger({ baseUrl, token, userId = "ledger-api-user" }) {
  const configured = Boolean(baseUrl && token);

  async function call(path, body) {
    if (!configured) throw Object.assign(new Error("Ledger API is not configured"), { status: 503 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(new URL(path, baseUrl), {
        method: body === undefined ? "GET" : "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
      if (!response.ok) throw Object.assign(new Error("Ledger rejected the request"), { status: response.status, ledgerReason: damlReason(text) });
      return parsed;
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(new Error("Ledger outcome unknown"), { status: 504, unknownOutcome: true });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // Submits one transaction for exactly the given acting party.
  async function submit(actAsParty, commands) {
    const result = await call("/v2/commands/submit-and-wait-for-transaction", {
      commands: { userId, commandId: `alluvren-${randomUUID()}`, actAs: [actAsParty], commands },
    });
    const events = Array.isArray(result?.transaction?.events) ? result.transaction.events : [];
    return {
      updateId: result?.transaction?.updateId ?? null,
      created: events.map((event) => event?.CreatedEvent).filter(Boolean).map((event) => ({ templateId: event.templateId, contractId: event.contractId })),
    };
  }

  // Active contracts visible to exactly one party.
  async function activeContracts(party) {
    const end = await call("/v2/state/ledger-end");
    const response = await call("/v2/state/active-contracts", {
      filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } },
      verbose: false,
      activeAtOffset: end.offset,
    });
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
