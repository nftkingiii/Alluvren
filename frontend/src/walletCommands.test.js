import assert from "node:assert/strict";
import { test } from "node:test";
import { isSignInChallenge, walletCommand, walletSubmission } from "./walletCommands.js";

const PARTY = `alluvren-investor-a::1220${"b".repeat(64)}`;

test("acknowledge and withdraw map to the plain and sealed choices", () => {
  assert.deepEqual(walletCommand("acknowledge", { contractId: "c1" }).ExerciseCommand, {
    templateId: "#alluvren-v1:Alluvren.Claims:ClaimEntitlement", contractId: "c1", choice: "ClaimEntitlement_Acknowledge", choiceArgument: {},
  });
  assert.equal(walletCommand("acknowledge", { contractId: "c2", sealed: true }).ExerciseCommand.choice, "PrivateEntitlement_Acknowledge");
  assert.equal(walletCommand("withdraw", { contractId: "c3" }).ExerciseCommand.templateId, "#alluvren-v1:Alluvren.Claims:OutstandingRedemption");
  assert.equal(walletCommand("withdraw", { contractId: "c4", sealed: true }).ExerciseCommand.choice, "PrivateOutstanding_Withdraw");
  assert.throws(() => walletCommand("transfer", { contractId: "c5" }), /Unknown wallet action/);
  assert.throws(() => walletCommand("acknowledge", {}), /contract ID/);
});

test("a submission acts as the wallet party alone", () => {
  const request = walletSubmission("acknowledge", { contractId: "00abcdef0123456789" }, PARTY, 42);
  assert.deepEqual(request.actAs, [PARTY]);
  assert.equal(request.commands.length, 1);
  assert.equal(request.commandId, "alluvren-acknowledge-00abcdef0123-42");
  assert.throws(() => walletSubmission("acknowledge", { contractId: "c" }, "not-a-party"), /wallet party/);
});

test("only the backend's sign-in text for this wallet and site is signed", () => {
  const good = `Sign in to Alluvren at 127.0.0.1:5173\nWallet: ${PARTY}\nNonce: ${"a".repeat(32)}\nExpires: 2026-10-21T14:05:00.000Z`;
  assert.equal(isSignInChallenge(good, PARTY, "127.0.0.1:5173"), true);
  assert.equal(isSignInChallenge(good, PARTY, "evil.example"), false);
  assert.equal(isSignInChallenge(good.replace(PARTY, `other::1220${"c".repeat(64)}`), PARTY, "127.0.0.1:5173"), false);
  assert.equal(isSignInChallenge(`${good}\nTransfer: everything`, PARTY, "127.0.0.1:5173"), false);
  assert.equal(isSignInChallenge(undefined, PARTY, "127.0.0.1:5173"), false);
});
