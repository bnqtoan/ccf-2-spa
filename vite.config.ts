import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'

// Mốc build THẬT — nhúng lúc build để /api/version phản ánh đúng commit đang
// chạy production (thay cho chuỗi tĩnh phải sửa tay). Ưu tiên biến CI của
// Cloudflare Workers Builds; nếu không có (build local, `npm run deploy`) thì
// đọc git trực tiếp. Cuối cùng fallback 'unknown' để build không bao giờ vỡ vì
// thiếu git (vd tarball không có .git).
function resolveBuildTag(): string {
  const ci = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.CF_PAGES_COMMIT_SHA
  const sha = ci ?? (() => {
    try {
      return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      return ''
    }
  })()
  const short = sha ? sha.slice(0, 7) : 'unknown'
  const date = new Date().toISOString().slice(0, 10)
  return `${date}-${short}`
}

export default defineConfig({
  // Hằng số thay lúc build; consume trong src/worker/routes/index.ts.
  define: {
    __BUILD_TAG__: JSON.stringify(resolveBuildTag()),
  },
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
