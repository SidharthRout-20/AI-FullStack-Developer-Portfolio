import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// Server requests go straight to the deployed backend (see src/lib/apiBase.js), so no dev proxy is needed.
// The shared core (packages/web-core) and Safarnama (products/safarnama/web, embedded at /safarnama) are used straight
// from source; `dedupe` makes their imports of React and friends resolve to this app's single copy in node_modules.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@appcore/web": here("../packages/web-core/src"),
      "@safarnama/web": here("../products/safarnama/web/src"),
    },
    dedupe: ["react", "react-dom", "lucide-react", "motion", "leaflet", "react-markdown", "remark-gfm", "@fontsource-variable/fraunces", "@neon/auth"],
  },
  server: {
    port: 5173,
    fs: { allow: [here("..")] },
  },
  build: {
    sourcemap: false, // don't ship source maps to production
    chunkSizeWarningLimit: 600, // main chunk ≈175 kB gzipped (React + Markdown + Motion)
  },
  test: {
    environment: "node",
  },
});
