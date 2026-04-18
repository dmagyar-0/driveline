---
description: Run a critical daily code review on commits since the last review
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# Daily Code Review

Run a critical review of new commits since the last review and write findings to a dated report. Skip silently if nothing new.

## Step 1 — Check for new commits

1. Read `.claude/daily-review-state.json` if it exists. It holds `{ "last_reviewed_sha": "<sha>", "last_reviewed_at": "<iso-date>" }`.
2. Run `git rev-parse HEAD` to get the current SHA.
3. If the state file is missing, treat `last_reviewed_sha` as the repo's first commit (`git rev-list --max-parents=0 HEAD`) so the first run reviews everything.
4. If `last_reviewed_sha == HEAD`:
   - Print: `No new commits since <sha> (<date>). Skipping review.`
   - **Stop here.** Do not write a report and do not update state.
5. Otherwise, collect the commit range `LAST..HEAD`:
   - `git log --oneline <LAST>..HEAD`
   - `git diff --stat <LAST>..HEAD`
   - `git diff <LAST>..HEAD` (read in chunks if large)

## Step 2 — Review the diff critically

Act as a senior reviewer. Be blunt, specific, and skeptical — do **not** soften findings or pad with praise. For every commit in range, evaluate:

- **Correctness**: logic bugs, off-by-one, race conditions, wrong error handling, broken invariants, unhandled edge cases.
- **Security**: injection, unsafe deserialization, secret leakage, auth/authz gaps, unsafe `unwrap`/`expect` in Rust, unchecked user input.
- **Performance**: obvious hot-path regressions, N+1, unnecessary allocations, blocking calls in async contexts.
- **API / contract**: breaking changes, inconsistent interfaces, leaky abstractions, missing invariants.
- **Tests**: missing coverage for new behavior, tests that assert the wrong thing, tests that can't fail.
- **Code quality**: dead code, premature abstraction, duplication, misleading names, comments that lie, TODOs left behind.
- **Dependencies**: new deps pulled in — are they necessary, maintained, appropriately scoped?
- **Docs**: drift between code and `README.md` / `docs/`.

For each issue, record:
- **File:line**
- **Severity**: `critical` | `high` | `medium` | `low` | `nit`
- **Category** (from the list above)
- **What's wrong** (one or two sentences)
- **Suggested fix** (concrete, not vague)

If a commit is clean, say so in one line — don't invent issues.

## Step 3 — Write the report

Write to `docs/reviews/YYYY-MM-DD-review.md` (use today's date; if the file exists, append a new section with a timestamp). Use this structure:

```markdown
# Daily Code Review — <YYYY-MM-DD>

**Range:** `<LAST_SHA>..<HEAD_SHA>` (<N> commits)

## Summary
<2-4 sentence verdict. State the worst finding up front.>

## Findings

### Critical
- **`path/to/file.rs:42`** — <what's wrong>. Fix: <concrete suggestion>.

### High
- ...

### Medium
- ...

### Low / Nits
- ...

## Per-commit notes
- `<sha>` <subject> — <one-line verdict, or "clean">

## Stats
- Files changed: <n>
- Insertions / deletions: +<n> / -<n>
- Test files touched: <n>
```

If there are zero findings across all severities, still write the report with an empty Findings section and a summary that says so — don't fabricate issues.

## Step 4 — Update state

Overwrite `.claude/daily-review-state.json` with:

```json
{
  "last_reviewed_sha": "<HEAD_SHA>",
  "last_reviewed_at": "<ISO-8601 timestamp>",
  "report_path": "docs/reviews/YYYY-MM-DD-review.md"
}
```

## Step 5 — Report back

Print a one-line summary to the user: range reviewed, number of findings by severity, path to the report. Nothing more.

## Notes

- Do **not** commit or push the report or state file unless the user explicitly asks.
- Do **not** modify any source files — this command only reads and writes review artifacts.
- If the diff is very large (>2000 lines), consider delegating sub-sections to `Agent` with `subagent_type: Explore` to keep the main context focused, then synthesize findings yourself.
