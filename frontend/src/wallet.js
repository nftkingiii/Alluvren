// CIP-0103 wallet for the Live ledger, through the Canton dApp SDK and the
// Wallet Gateway next to LocalNet. Signing in is signing the backend's
// challenge with the wallet; an investor whose party is its own wallet also
// signs its acknowledgments and withdrawals here.
import { RemoteAdapter, dappSDK } from "@canton-network/dapp-sdk";
import { isSignInChallenge, walletSubmission } from "./walletCommands.js";

const GATEWAY_URL = import.meta.env.VITE_WALLET_GATEWAY_URL || "http://localhost:3030/api/v0/dapp";

let initialized = null;
async function ensureInit() {
  // Only Alluvren's gateway, not the SDK's default list of public wallets.
  initialized ??= dappSDK.init({
    defaultAdapters: [new RemoteAdapter({ name: "Alluvren Wallet Gateway (LocalNet)", rpcUrl: GATEWAY_URL })],
    enableSuggestedWallets: false,
  });
  return initialized;
}

const sdkWallet = {
  async connect() {
    await ensureInit();
    const result = await dappSDK.connect();
    if (!result?.isConnected) throw new Error(result?.reason || "The wallet did not connect");
    const accounts = await dappSDK.listAccounts();
    const account = accounts.find((a) => a.primary) ?? accounts[0];
    if (!account) throw new Error("The wallet has no party yet");
    return { partyId: account.partyId, publicKey: account.publicKey };
  },
  async signMessage(message) {
    return (await dappSDK.signMessage({ message })).signature;
  },
  async submit(request) {
    const { tx } = await dappSDK.prepareExecuteAndWait(request);
    return { updateId: tx?.payload?.updateId ?? null };
  },
  async disconnect() {
    if (initialized) await dappSDK.disconnect().catch(() => null);
  },
};

// Playwright's mocked specs swap in a scripted wallet. The branch only exists
// in builds made with VITE_E2E_WALLET=1, never in a normal build.
const wallet = () => (import.meta.env.VITE_E2E_WALLET === "1" && globalThis.__ALLUVREN_E2E_WALLET__) || sdkWallet;

// Signing in is two steps, each started by the person: connect, then sign. The
// gateway's login page redirects its popup once it has posted the session, and
// a signing request sent straight after connecting can lose that race and never
// show; by the second click the popup has settled.
export function connectWallet() {
  return wallet().connect();
}

// Fetch the backend's challenge for this wallet, check it is the sign-in text
// for this site, sign it, and exchange it for a session.
export async function signInWithWallet(api, { partyId, publicKey }) {
  const { message } = await api.walletChallenge(partyId);
  if (!isSignInChallenge(message, partyId, window.location.host)) throw new Error("Unexpected sign-in challenge; nothing was signed");
  const signature = await wallet().signMessage(message);
  return api.walletSignIn({ wallet: partyId, publicKey, signature, message });
}

// Acknowledge or withdraw one of the wallet party's own records; the wallet
// asks for approval and signs with its key.
export function actWithWallet(action, record, party) {
  return wallet().submit(walletSubmission(action, record, party));
}

export function disconnectWallet() {
  return wallet().disconnect();
}
