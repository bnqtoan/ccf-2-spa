# Orchestration rules

Use this file when driving work with subagents / parallel executors (the intended
pattern for this repo — keep it; don't collapse into building in-session).

## Plan the seams before dispatch
- A card's `touches` must be **real and complete** (validated against the repo).
  A UI-facing gap almost always needs backend files too (endpoint/payload) — include
  them up front, don't let the executor discover it and block.
- **Two cards editing the same file can't truly run in parallel.** Either sequence
  them (`depends_on`), or split so each owns a disjoint file/region and integrate at
  merge. Decide collisions **before** dispatch, never at merge time.
- Encode dependencies in card frontmatter, not in PR base (open all PRs against main).

## Planner reviews, executors write
- After each executor: read the diff, confirm `touches` wasn't exceeded, **run the
  tests yourself**, then merge. A per-card pass is not integrated-green — run the full
  suite on `main` after merging and cite real output.
- **Actively watch** a running executor (read its worktree/transcript on each check),
  don't park silently on a timer.
- Fresh git worktrees have **no `node_modules` / `.dev.vars`** — the executor must
  `npm install` + `cp` the dev vars + migrate local D1 before verifying, else the
  results are meaningless.

## Decide vs. ask
- Routine review/merge/dispatch: decide and log, keep moving.
- Halt and ask only for genuine scope decisions, unresolvable conflicts, or
  irreversible actions. Batch questions; don't interrupt per-tick.

## Root cause, never paper over
- If a fix needs `retries` / global-serialize / suppression to go green, that's a
  symptom patch — find the real cause. Widen to one root-cause card rather than
  iterating workarounds on the symptom.
