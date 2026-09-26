import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { createLedger } from "../src/ledger.mjs";

// Fake participants are closed after every test, pass or fail, so a failing
// assertion reports instead of leaving the runner waiting on open sockets.
const open = [];
afterEach(async () => { await Promise.all(open.splice(0).map((p) => p.close())); });

// A fake JSON Ledger API participant that records the requests it receives.
// It reports itself connected to a synchronizer unless told otherwise; those
// health checks are answered here and not recorded as calls.
async function participant(name, respond, { connected = true } = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : null;
    if (req.url.startsWith("/v2/state/connected-synchronizers")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ connectedSynchronizers: connected ? [{ synchronizerAlias: "global" }] : [] }));
    }
    calls.push({ path: req.url, body });
    const [status, payload] = respond(req.url, body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const handle = { name, calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
  open.push(handle);
  return handle;
}

const ok = (name) => (path) => path.startsWith("/v2/state/ledger-end")
  ? [200, { offset: name === "backup" ? 7 : 9 }]
  : path.startsWith("/v2/state/active-contracts")
    ? [200, [{ contractEntry: { JsActiveContract: { createdEvent: { contractId: `${name}-cid`, templateId: "pkg:Alluvren.Claims:ClaimEntitlement", createArgument: {} } } } }]]
    : [200, { transaction: { updateId: `${name}-update`, events: [] } }];

async function closedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => server.close(r));
  return url;
}

test("a submission moves to the backup only when the primary is unreachable", async () => {
  const backup = await participant("backup", ok("backup"));
  const ledger = createLedger({ baseUrl: `${await closedPort()},${backup.url}`, token: "t" });
  const result = await ledger.submit("alice", []);
  assert.equal(result.updateId, "backup-update");
  assert.equal(backup.calls.length, 1);
});

test("a submission moves to the backup when the primary is not connected to a synchronizer, with the same command ID", async () => {
  const primary = await participant("primary", () => [503, { code: "NOT_CONNECTED_TO_ANY_SYNCHRONIZER", cause: "not connected" }]);
  const backup = await participant("backup", ok("backup"));
  const ledger = createLedger({ baseUrl: `${primary.url},${backup.url}`, token: "t" });
  assert.equal((await ledger.submit("alice", [])).updateId, "backup-update");
  assert.equal(primary.calls[0].body.commands.commandId, backup.calls[0].body.commands.commandId);
});

test("a ledger rejection or an ambiguous server error is never retried elsewhere", async () => {
  const cases = [
    [400, { cause: "DAML_FAILURE: The requirement 'Missing required approvals for role ComplianceReviewer' was not met" }, "Missing required approvals for role ComplianceReviewer"],
    [500, { cause: "internal error" }, null],
  ];
  for (const [status, payload, reason] of cases) {
    const primary = await participant("primary", () => [status, payload]);
    const backup = await participant("backup", ok("backup"));
    const ledger = createLedger({ baseUrl: `${primary.url},${backup.url}`, token: "t" });
    await assert.rejects(ledger.submit("alice", []), (error) => error.status === status && (error.ledgerReason ?? null) === reason);
    assert.equal(backup.calls.length, 0, `status ${status} must not reach the backup`);
  }
});

test("reads fail over and take the ledger end and snapshot from the same participant", async () => {
  const primary = await participant("primary", () => [500, { cause: "down" }]);
  const backup = await participant("backup", ok("backup"));
  const ledger = createLedger({ baseUrl: `${primary.url},${backup.url}`, token: "t" });
  const contracts = await ledger.activeContracts("alice");
  assert.deepEqual(contracts.map((c) => c.contractId), ["backup-cid"]);
  assert.deepEqual(backup.calls.map((c) => c.path), ["/v2/state/ledger-end", "/v2/state/active-contracts"]);
  assert.equal(backup.calls[1].body.activeAtOffset, 7);
});

test("a participant that reports no connected synchronizer is used last, even though it still answers", async () => {
  const stale = await participant("stale", ok("stale"), { connected: false });
  const backup = await participant("backup", ok("backup"));
  const ledger = createLedger({ baseUrl: `${stale.url},${backup.url}`, token: "t" });
  assert.deepEqual((await ledger.activeContracts("alice")).map((c) => c.contractId), ["backup-cid"]);
  assert.equal((await ledger.submit("alice", [])).updateId, "backup-update");
  assert.equal(stale.calls.length, 0);
});

test("a party hosted only on the backup is read and submitted there when the primary refuses it", async () => {
  const primary = await participant("primary", (p) => p.startsWith("/v2/state/ledger-end")
    ? [200, { offset: 9 }]
    : [403, { code: "NA", cause: "A security-sensitive error has been received", grpcCodeValue: 7 }]);
  const backup = await participant("backup", ok("backup"));
  const ledger = createLedger({ baseUrl: `${primary.url},${backup.url}`, token: "t" });
  assert.deepEqual((await ledger.activeContracts("member")).map((c) => c.contractId), ["backup-cid"]);
  assert.equal((await ledger.submit("member", [])).updateId, "backup-update");
  assert.equal(primary.calls.filter((c) => c.path.startsWith("/v2/commands")).length, 1);
});
