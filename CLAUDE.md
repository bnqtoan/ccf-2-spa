# CLAUDE.md — ccf-2-spa

Cloudflare Workers + Hono + D1 + Vite SPA (spa booking app). Vietnamese UI.

## Sources of truth (read before working — don't restate them here)
- `docs/tasks/BOARD.md` — task board + status rules (`todo→in_progress→review→done`; **agents never self-set `done`**).
- `docs/tasks/CONVENTIONS.md` — time/slotting/status/schema/API/validation/dir-structure/tests/agent-rules.
- `docs/PRD.md` — business rules. `docs/tasks/_TEMPLATE.md` — card shape.

## Build / verify
- `npm run typecheck` · `npm test` (vitest, API+unit) · `npm run e2e` (playwright).
- **Show evidence, not assertions:** paste the command + real output. "Tests pass" without output isn't done.
- E2E: seed via the in-process binding helper (`tests/e2e/_seed.ts`), NOT by spawning `wrangler d1 execute` per test — the subprocess-per-seed pattern is slow + causes SQLITE_BUSY. Run seed-heavy specs serially per project; keep pure-HTTP specs parallel.

## Orchestration (when driving with subagents — the pattern is intended, keep it)
- **Plan the seams before dispatch.** A card's `touches`/`allowed_files` must be real (validated against the repo) and its dependencies explicit. Two cards that edit the same file can't truly run in parallel — either sequence them or give each a disjoint file/region and integrate at merge. Decide collisions up front, never discover them at merge.
- **Widen a card's `touches` before dispatch, not after it blocks.** A UI-facing gap usually needs backend files too (endpoint/payload) — include them.
- **Planner reviews + verifies; executors write.** After each executor: read the diff, run the tests yourself, confirm `touches` wasn't exceeded — then merge. A per-card pass is not integrated-green; run the full suite on main after merging.
- **Actively watch a running executor** (read its worktree/transcript), don't park silently.
- Fresh git worktrees have **no `node_modules`/`.dev.vars`** — install + copy before verifying, else results are meaningless.

## Working style
- Root-cause over symptom. If a fix needs a workaround (retries, global-serialize) to go green, find the real cause instead.
- For small/linear tasks, correcting early beats a long chain — surface a wrong turn fast.
