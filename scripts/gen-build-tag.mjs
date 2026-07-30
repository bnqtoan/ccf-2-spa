// GHI ĐÈ src/worker/build-tag.ts bằng mốc build THẬT (`YYYY-MM-DD-<sha7>`),
// chạy TRƯỚC khi bundle worker (wrangler.jsonc `build.command`) nên chắc chắn
// chạy trong MỌI đường deploy (wrangler deploy / Workers Builds), không phụ
// thuộc bundler có honor Vite `define` hay không — build-tag.ts được import như
// mã nguồn thường nên bundler nào cũng gộp vào. File đích được commit sẵn (giá
// trị 'dev'); script này chỉ đổi nội dung lúc build, không cần commit lại.
//
// Nguồn SHA: biến CI của Workers Builds (WORKERS_CI_COMMIT_SHA /
// CF_PAGES_COMMIT_SHA) trước, rồi `git rev-parse`, cuối cùng 'unknown'.

import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

function sha() {
  const ci = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.CF_PAGES_COMMIT_SHA
  if (ci && ci.trim()) return ci.trim().slice(0, 7)
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

const tag = `${new Date().toISOString().slice(0, 10)}-${sha()}`
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'worker', 'build-tag.ts')
writeFileSync(
  out,
  `// GHI ĐÈ bởi scripts/gen-build-tag.mjs lúc build (wrangler.jsonc build.command).\n` +
    `// Giá trị commit sẵn là 'dev'; đừng sửa tay giá trị sinh ra.\n` +
    `export const BUILD_TAG = '${tag}'\n`,
)
console.log(`[gen-build-tag] ${tag}`)
