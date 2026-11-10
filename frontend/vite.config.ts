import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In dev, the Vite server proxies /api → FastAPI so the browser sees a single
// origin (no CORS needed). In production FastAPI serves the built files itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "https://ai-full-stack-developer-portfolio-j.vercel.app/",
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: false, // don't ship source maps to production
    chunkSizeWarningLimit: 600, // main chunk ≈175 kB gzipped (React + Markdown + Motion)
  },
  test: {
    environment: "node",
  },
});
