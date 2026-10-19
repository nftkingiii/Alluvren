// The dApp SDK imports WalletConnect statically for its optional
// WalletConnectAdapter. Alluvren only registers its own Wallet Gateway
// (RemoteAdapter), so vite.config.js points the import here instead of
// shipping WalletConnect. Using it fails loudly rather than silently.
export default class SignClient {
  static async init() {
    throw new Error("WalletConnect is not enabled in Alluvren; connect through the Wallet Gateway");
  }
}
