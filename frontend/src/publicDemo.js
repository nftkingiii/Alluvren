// Public builds (e.g. the hosted demo) have no backend or LocalNet behind them.
// VITE_PUBLIC_DEMO=true shows the walkthrough and, on the Live tab, a notice
// pointing to the demo video and the reproduction guide instead of a sign-in.
export const PUBLIC_DEMO = import.meta.env?.VITE_PUBLIC_DEMO === "true";
export const DEMO_VIDEO_URL = import.meta.env?.VITE_DEMO_VIDEO_URL || "";
export const REPO_URL = "https://github.com/nftkingiii/Alluvren";
