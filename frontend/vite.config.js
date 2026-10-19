import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: {
    // See src/vendor/walletconnect-stub.js.
    alias: { "@walletconnect/sign-client": fileURLToPath(new URL("./src/vendor/walletconnect-stub.js", import.meta.url)) },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/healthz": "http://127.0.0.1:8787",
    },
  },
});
