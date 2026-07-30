# CLAUDE.md — ccf-2-spa

Cloudflare Workers + Hono + D1 + Vite SPA (spa booking app). Vietnamese UI.

## Sources of truth (read before working — don't restate them here)
- `docs/tasks/BOARD.md` — task board + status rules (`todo→in_progress→review→done`; **agents never self-set `done`**).
- `docs/tasks/CONVENTIONS.md` — time/slotting/status/schema/API/validation/dir-structure/tests/agent-rules.
- `docs/PRD.md` — business rules. `docs/tasks/_TEMPLATE.md` — card shape.

## Topic rules (auto-load by path — see `.claude/rules/`)
- `e2e-testing.md` — loads when touching `tests/e2e/**` or `playwright.config.ts`.
- `orchestration.md` — driving subagents / parallel executors.

## Build / verify
- `npm run typecheck` · `npm test` (vitest) · `npm run e2e` (playwright).
- **Show evidence, not assertions:** paste the command + real output. "Tests pass" / "done" without output isn't done. Fix root causes; don't paper over.
