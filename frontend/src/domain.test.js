import test from "node:test";
import assert from "node:assert/strict";
import {
  allocate,
  investors,
  initialState,
  transition,
  canExecute,
} from "./domain.js";
const act = (s, type, args = {}) =>
  transition(s, {
    type,
    version: s.active,
    id: "test",
    time: "12:00",
    ...args,
  });
test("canonical partial allocation conserves units", () => {
  const rows = allocate(investors, 50000);
  assert.deepEqual(
    rows.map((r) => r.allocated),
    [30000, 15000, 5000],
  );
  assert.ok(rows.every((r) => r.allocated + r.outstanding === r.units));
});
test("rounding follows immutable sequence, not display order", () => {
  const rows = [
    { id: "b", seq: 2, units: 1 },
    { id: "a", seq: 1, units: 1 },
  ];
  assert.deepEqual(
    allocate(rows, 1).map((r) => r.allocated),
    [0, 1],
  );
});
test("zero, empty and excess reserves", () => {
  assert.deepEqual(allocate([], 50), []);
  assert.ok(allocate(investors, 0).every((r) => r.allocated === 0));
  assert.ok(allocate(investors, 200000).every((r) => r.outstanding === 0));
});
test("invalid and duplicate input rejected", () => {
  assert.throws(() => allocate(investors, -1));
  assert.throws(() => allocate([investors[0], investors[0]], 3));
});
test("requires both roles and threshold, prevents replay", () => {
  let s = initialState();
  assert.throws(() => act(s, "execute"));
  s = act(s, "approve", { role: "fund" });
  assert.throws(() => act(s, "approve", { role: "fund" }));
  assert.throws(() => act(s, "confirm", { member: "A" }));
  s = act(s, "approve", { role: "treasury" });
  s = act(s, "confirm", { member: "A" });
  assert.equal(canExecute(s, 1), false);
  s = act(s, "confirm", { member: "B" });
  assert.equal(canExecute(s, 1), true);
  s = act(s, "execute");
  assert.throws(() => act(s, "execute"));
  s = act(s, "claim", { investor: "REQ-001" });
  assert.throws(() => act(s, "claim", { investor: "REQ-001" }));
});
test("replacement invalidates approvals and blocks stale execution", () => {
  let s = act(initialState(), "approve", { role: "fund" });
  s = act(s, "replace", { liquidity: 40000 });
  assert.equal(s.versions[0].approvals.length, 1);
  assert.deepEqual(s.versions[1].approvals, []);
  assert.throws(() => act(s, "execute", { version: 1 }), /Stale/);
  assert.throws(
    () => act(s, "approve", { version: 1, role: "treasury" }),
    /Stale/,
  );
});
