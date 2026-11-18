import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

// The shared core (packages/web-core) is used straight from source. `dedupe` makes its imports of React and friends
// resolve to this app's single copy in node_modules.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@appcore/web': here('../../../packages/web-core/src') },
    dedupe: ['react', 'react-dom', 'lucide-react', 'motion', 'leaflet', 'react-markdown', 'remark-gfm', '@fontsource-variable/fraunces'],
  },
  server: { port: 5175, fs: { allow: [here('../../..')] } },
  build: { sourcemap: false },
  test: { environment: 'node' },
})
