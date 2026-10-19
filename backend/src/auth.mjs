import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";

// Wallet sign-in (CIP-0103). There are no passwords: a person proves they
// hold a wallet by signing a one-time challenge with its Ed25519 key, and the
// account bound to that wallet decides which ledger party and roles the
// session gets. Authorization below only relies on the session's party and
// roles.

export const APPROVAL_ROLES = ["FundReviewer", "TreasuryReviewer", "ComplianceReviewer", "AdministratorCheck", "FinalSignoff"];
export const APP_ROLES = ["Operator", "GovernanceMember", "Investor", ...APPROVAL_ROLES];
const PARTY_PATTERN = /^[A-Za-z0-9_-]{1,185}::[0-9a-f]{68}$/;
// A wallet party's namespace is its own key's fingerprint (see walletNamespace).
const WALLET_PATTERN = /^[A-Za-z0-9_-]{1,185}::1220[0-9a-f]{64}$/;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_OPEN_CHALLENGES = 1000;
// Strict per wallet; looser per IP so one attacker cannot lock out everyone
// behind a shared address.
const LOGIN_MAX_PER_WALLET = 5;
const LOGIN_MAX_PER_IP = 30;
// Canton's hash purpose for public key fingerprints.
const FINGERPRINT_PURPOSE = 12;
// DER prefix of an Ed25519 SubjectPublicKeyInfo, before the 32 raw key bytes.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// The Canton namespace of an Ed25519 key: "1220" (SHA-256 multihash) followed
// by SHA-256(uint32be(12) || raw public key), in hex. A wallet party created
// by a Wallet Gateway is "<hint>::<this namespace>", so a key either belongs
// to the party or it doesn't; no ledger lookup is needed.
export function walletNamespace(publicKeyBase64) {
  const raw = Buffer.from(String(publicKeyBase64), "base64");
  if (raw.length !== 32) return null;
  const purpose = Buffer.alloc(4);
  purpose.writeUInt32BE(FINGERPRINT_PURPOSE);
  return `1220${createHash("sha256").update(Buffer.concat([purpose, raw])).digest("hex")}`;
}

// True when signatureBase64 is an Ed25519 signature by publicKeyBase64 over
// the message's raw UTF-8 bytes, the format CIP-0103 signMessage returns.
export function verifyWalletSignature(message, signatureBase64, publicKeyBase64) {
  const raw = Buffer.from(String(publicKeyBase64), "base64");
  const signature = Buffer.from(String(signatureBase64), "base64");
  if (raw.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verifySignature(null, Buffer.from(String(message), "utf8"), key, signature);
  } catch {
    return false;
  }
}

export function loadAccounts(path, nodeNames) {
  if (!path) return new Map();
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const users = Array.isArray(parsed?.users) ? parsed.users : [];
  const accounts = new Map();
  const wallets = new Set();
  for (const user of users) {
    const where = `account ${JSON.stringify(user?.username)}`;
    if (typeof user?.username !== "string" || !/^[a-z0-9._-]{3,40}$/.test(user.username)) throw new Error(`${where}: invalid username`);
    if (accounts.has(user.username)) throw new Error(`${where}: duplicate username`);
    if (user.passwordHash !== undefined) throw new Error(`${where}: password accounts are not supported; bind a wallet instead`);
    if (typeof user.wallet !== "string" || !WALLET_PATTERN.test(user.wallet)) throw new Error(`${where}: wallet must be a Wallet Gateway party id`);
    if (wallets.has(user.wallet)) throw new Error(`${where}: wallet is already bound to another account`);
    if (typeof user.party !== "string" || !PARTY_PATTERN.test(user.party)) throw new Error(`${where}: invalid party`);
    if (!Array.isArray(user.roles) || user.roles.length === 0 || user.roles.some((role) => !APP_ROLES.includes(role))) throw new Error(`${where}: roles must be a non-empty subset of ${APP_ROLES.join(", ")}`);
    if (user.roles.includes("Investor") && user.roles.length > 1) throw new Error(`${where}: an Investor account cannot hold staff roles`);
    if (user.wallet === user.party && !user.roles.includes("Investor")) throw new Error(`${where}: only an investor can act as its own wallet party`);
    if (user.roles.includes("GovernanceMember")) {
      if (!nodeNames.includes(user.decmanNode)) throw new Error(`${where}: GovernanceMember needs a configured decmanNode`);
    } else if (user.decmanNode !== undefined && user.decmanNode !== null) {
      throw new Error(`${where}: decmanNode is only valid for GovernanceMember`);
    }
    wallets.add(user.wallet);
    accounts.set(user.username, Object.freeze({
      username: user.username,
      wallet: user.wallet,
      party: user.party,
      roles: Object.freeze([...user.roles]),
      decmanNode: user.decmanNode ?? null,
    }));
  }
  return accounts;
}

export function createAuth({ accounts, now = () => Date.now() }) {
  const sessions = new Map();
  const attempts = new Map();
  const challenges = new Map();
  const byWallet = new Map([...accounts.values()].map((account) => [account.wallet, account]));

  function throttled(key, limit) {
    const t = now();
    const entry = attempts.get(key);
    if (!entry || t - entry.started > LOGIN_WINDOW_MS) return false;
    return entry.count >= limit;
  }
  function recordFailure(key) {
    const t = now();
    const entry = attempts.get(key);
    if (!entry || t - entry.started > LOGIN_WINDOW_MS) attempts.set(key, { started: t, count: 1 });
    else entry.count += 1;
  }
  function pruneChallenges() {
    const t = now();
    for (const [nonce, entry] of challenges) if (entry.expires <= t) challenges.delete(nonce);
  }

  // The text the wallet signs. It names the site, the wallet and an expiry so
  // a signature cannot be replayed elsewhere, for another wallet or later.
  // Issued for any well-formed wallet so it does not reveal which are bound.
  function challenge(wallet, domain, ip) {
    if (typeof wallet !== "string" || !WALLET_PATTERN.test(wallet)) return { status: "invalid" };
    if (throttled(`ip:${ip}`, LOGIN_MAX_PER_IP)) return { status: "throttled" };
    pruneChallenges();
    if (challenges.size >= MAX_OPEN_CHALLENGES) return { status: "throttled" };
    const nonce = randomBytes(16).toString("hex");
    const expires = now() + CHALLENGE_TTL_MS;
    const message = [
      `Sign in to Alluvren at ${domain}`,
      `Wallet: ${wallet}`,
      `Nonce: ${nonce}`,
      `Expires: ${new Date(expires).toISOString()}`,
    ].join("\n");
    challenges.set(nonce, { wallet, message, expires });
    return { status: "ok", message };
  }

  function login({ wallet, publicKey, signature, message }, ip) {
    const walletKey = `w:${String(wallet).slice(0, 260)}`;
    const ipKey = `ip:${ip}`;
    if (throttled(walletKey, LOGIN_MAX_PER_WALLET) || throttled(ipKey, LOGIN_MAX_PER_IP)) return { status: "throttled" };
    const nonce = /^Nonce: ([0-9a-f]{32})$/m.exec(String(message ?? ""))?.[1];
    const issued = nonce ? challenges.get(nonce) : undefined;
    // One attempt per challenge, whatever the outcome.
    if (nonce) challenges.delete(nonce);
    const account = typeof wallet === "string" ? byWallet.get(wallet) : undefined;
    const ok = Boolean(issued)
      && issued.expires > now()
      && issued.wallet === wallet
      && issued.message === message
      && walletNamespace(publicKey) === String(wallet).split("::")[1]
      && verifyWalletSignature(message, signature, publicKey)
      && Boolean(account);
    if (!ok) {
      recordFailure(walletKey);
      recordFailure(ipKey);
      return { status: "invalid" };
    }
    attempts.delete(walletKey);
    const id = randomBytes(32).toString("base64url");
    const session = {
      id,
      csrfToken: randomBytes(32).toString("base64url"),
      username: account.username,
      wallet: account.wallet,
      party: account.party,
      roles: account.roles,
      decmanNode: account.decmanNode,
      createdAt: now(),
      lastSeen: now(),
    };
    sessions.set(id, session);
    return { status: "ok", session };
  }

  function get(id) {
    if (typeof id !== "string") return null;
    const session = sessions.get(id);
    if (!session) return null;
    const t = now();
    if (t - session.createdAt > SESSION_TTL_MS || t - session.lastSeen > SESSION_IDLE_MS) {
      sessions.delete(id);
      return null;
    }
    session.lastSeen = t;
    return session;
  }

  function logout(id) {
    sessions.delete(id);
  }

  return { challenge, login, get, logout, sessionMaxAgeSeconds: SESSION_TTL_MS / 1000 };
}

// An account whose ledger party is its own wallet party acts on the ledger
// only through that wallet: the backend never submits as it.
export function actsThroughWallet(session) {
  return Boolean(session && session.wallet === session.party);
}

export function publicUser(session) {
  return {
    username: session.username,
    wallet: session.wallet,
    party: session.party,
    roles: [...session.roles],
    actsThroughWallet: actsThroughWallet(session),
  };
}

export function hasRole(session, role) {
  return Boolean(session?.roles.includes(role));
}

export function isStaff(session) {
  return Boolean(session && !session.roles.includes("Investor"));
}
