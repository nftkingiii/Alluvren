// Drives the Canton Wallet Gateway (CIP-0103) on BitSafe LocalNet for the
// investor wallet: the same dApp API calls the frontend's Wallet panel makes,
// plus the User API calls behind the gateway's Approve page.
//
//   node infra/wallet-gateway.mjs setup <name>              create <name>'s gateway user and wallet party
//   node infra/wallet-gateway.mjs party <name>              print <name>'s wallet party
//   node infra/wallet-gateway.mjs entitlements <name>       list the wallet's entitlements (JSON)
//   node infra/wallet-gateway.mjs acknowledge <name> <cid>  acknowledge one, signed by the wallet key
//   node infra/wallet-gateway.mjs receipts <name>           list the wallet's receipts (JSON)
//
// <name> is an Alluvren account name such as investor-a or treasury. Its
// gateway user, and the hint of its wallet party, is alluvren-<name>; that is
// the client ID to enter in the gateway's login page.
//
// LocalNet only. Logins are the gateway's self_signed development tokens over
// LocalNet's public `unsafe` secret, and the wallet key lives in the gateway's
// development signing store. Nothing here works on, or is meant for, a real
// network.
import { createHmac } from "node:crypto";

const GATEWAY = process.env.WALLET_GATEWAY_URL ?? "http://127.0.0.1:3030";
const NETWORK = process.env.WALLET_NETWORK ?? "canton:localnet";
const LEDGER = process.env.WALLET_LEDGER_URL ?? "http://127.0.0.1:2975";
let USER_ID = "";
let PARTY_HINT = "";
function forAccount(name) {
  if (!/^[a-z0-9._-]{3,40}$/.test(name ?? "")) throw new Error("an account name such as investor-a is required");
  USER_ID = `alluvren-${name}`;
  PARTY_HINT = `alluvren-${name}`;
}
const ORIGIN = process.env.WALLET_ORIGIN ?? "http://localhost:5173";
const CLAIMS = "#alluvren-v1:Alluvren.Claims";
const SECRET = "unsafe"; // LocalNet's public development secret
const AUDIENCE = "https://canton.network.global";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function hs256(header, claims) {
  const head = b64(header);
  const body = b64(claims);
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
const now = () => Math.floor(Date.now() / 1000);
// The gateway finds the network that verifies a self_signed login by `kid`.
const userToken = () => hs256({ alg: "HS256", typ: "JWT", kid: NETWORK },
  { iss: "self-signed", sub: USER_ID, aud: AUDIENCE, scope: "openid daml_ledger_api offline_access", iat: now(), exp: now() + 3600 });
// LocalNet's participant admin, used only to create the investor's ledger user.
const adminToken = () => hs256({ alg: "HS256", typ: "JWT" }, { aud: AUDIENCE, sub: "ledger-api-user", iat: now() });

let rpcId = 0;
async function rpc(path, method, params, token) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params ?? {} }),
  });
  const reply = await res.json().catch(() => ({}));
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
}

async function connect() {
  const token = userToken();
  const session = await rpc("/api/v0/user", "addSession", { networkId: NETWORK, origin: ORIGIN }, token);
  if (session.status !== "connected") throw new Error(`gateway session is ${session.status}: ${session.reason}`);
  return token;
}
const user = (token, method, params) => rpc("/api/v0/user", method, params, token);
const dapp = (token, method, params) => rpc("/api/v0/dapp", method, params, token);

async function walletParty(token) {
  const wallets = await user(token, "listWallets");
  const wallet = wallets.find((w) => w.primary) ?? wallets[0];
  if (!wallet) throw new Error("no wallet yet: run `node infra/wallet-gateway.mjs setup`");
  return wallet.partyId;
}

// Reads go through the dApp API's ledgerApi proxy, which authorizes them for
// the connected wallet, as in the browser.
async function activeContracts(token, party, templateSuffix) {
  const end = await dapp(token, "ledgerApi", { requestMethod: "get", resource: "/v2/state/ledger-end" });
  const rows = await dapp(token, "ledgerApi", {
    requestMethod: "post",
    resource: "/v2/state/active-contracts",
    body: {
      activeAtOffset: end.offset,
      eventFormat: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } }, verbose: false },
    },
  });
  return (Array.isArray(rows) ? rows : [])
    .map((row) => row.contractEntry?.JsActiveContract?.createdEvent)
    .filter((event) => event && event.templateId.endsWith(templateSuffix))
    .map((event) => ({ contractId: event.contractId, ...event.createArgument }));
}

async function setup() {
  // The gateway forwards the login token to the participant, which only
  // accepts a subject that exists as a ledger user.
  const res = await fetch(`${LEDGER}/v2/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ user: { id: USER_ID, primaryParty: "", isDeactivated: false, identityProviderId: "", metadata: { resourceVersion: "", annotations: {} } }, rights: [] }),
  });
  const text = await res.text();
  if (!res.ok && !/ALREADY_EXISTS|already exists/i.test(text)) throw new Error(`create ledger user ${USER_ID}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const token = await connect();
  const existing = (await user(token, "listWallets")).find((w) => w.hint === PARTY_HINT);
  if (existing) return existing.partyId;
  // wallet-kernel: the gateway holds the party's Ed25519 key and signs.
  const { wallet } = await user(token, "createWallet", { partyHint: PARTY_HINT, signingProviderId: "wallet-kernel", primary: true });
  return wallet.partyId;
}

async function acknowledge(entitlementCid) {
  const token = await connect();
  const party = await walletParty(token);
  const commandId = `alluvren-wallet-ack-${Date.now()}`;
  await dapp(token, "prepareExecute", {
    commandId,
    actAs: [party],
    commands: [{ ExerciseCommand: { templateId: `${CLAIMS}:ClaimEntitlement`, contractId: entitlementCid, choice: "ClaimEntitlement_Acknowledge", choiceArgument: {} } }],
  });
  // What the gateway's Approve page does when the investor clicks Approve.
  const { transactions } = await user(token, "listTransactions");
  const tx = transactions.find((t) => t.commandId === commandId);
  if (!tx) throw new Error(`gateway has no transaction for ${commandId}`);
  const signed = await user(token, "sign", { transactionId: tx.id, partyId: party });
  const executed = await user(token, "execute", { transactionId: tx.id, partyId: party });
  return { commandId, signedBy: signed.signedBy, updateId: executed.updateId, completionOffset: executed.completionOffset };
}

const [command, name, arg] = process.argv.slice(2);
const out = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
try {
  forAccount(name);
  if (command === "setup") out(await setup());
  else if (command === "party") out(await walletParty(await connect()));
  else if (command === "entitlements" || command === "receipts") {
    const token = await connect();
    out(await activeContracts(token, await walletParty(token), command === "entitlements" ? ":ClaimEntitlement" : ":ClaimReceipt"));
  } else if (command === "acknowledge" && arg) out(await acknowledge(arg));
  else {
    console.error("usage: node infra/wallet-gateway.mjs setup|party|entitlements|receipts <name>, or acknowledge <name> <entitlement-cid>");
    process.exit(2);
  }
} catch (error) {
  console.error(`wallet-gateway: ${error.message}`);
  process.exit(1);
}
