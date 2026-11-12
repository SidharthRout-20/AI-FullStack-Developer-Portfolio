import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Server requests go straight to the deployed backend (see src/lib/apiBase.ts), so no dev proxy is needed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
  },
  build: {
    sourcemap: false, // don't ship source maps to production
    chunkSizeWarningLimit: 600, // main chunk ≈175 kB gzipped (React + Markdown + Motion)
  },
  test: {
    environment: "node",
  },
});
