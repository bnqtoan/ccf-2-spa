import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  root: 'src/app',
  // Vite mặc định lấy publicDir = <root>/public = src/app/public, nhưng ảnh
  // tĩnh của revamp nằm ở public/ tại gốc repo (đúng vị trí Cloudflare Workers
  // assets binding đọc sau khi build — xem wrangler.jsonc assets.directory =
  // "./dist/client"). Không set lại thì `npm run dev` trả về index.html (SPA
  // fallback) cho mọi request /images/*, và `npm run build` không copy ảnh
  // vào dist/client — ảnh 404 im lặng cả dev lẫn production.
  publicDir: '../../public',
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
