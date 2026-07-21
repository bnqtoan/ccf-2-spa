import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  root: 'src/app',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  plugins: [
    react(),
    cloudflare({
      configPath: '../../wrangler.jsonc',
      // Vite root is src/app; without this the plugin persists local D1/dev
      // state under src/app/.wrangler instead of the project-root .wrangler
      // that .gitignore expects.
      persistState: { path: '../../.wrangler/state' },
    }),
  ],
})
