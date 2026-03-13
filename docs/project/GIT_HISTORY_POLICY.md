# Git History and Branch Hygiene

Last updated: March 13, 2026

## Repository Merge Settings

Configured on GitHub repository `davisbuilds/agentmonitor`:

- `allow_squash_merge`: `true`
- `allow_merge_commit`: `false`
- `allow_rebase_merge`: `false`
- `delete_branch_on_merge`: `true`
- `squash_merge_commit_title`: `PR_TITLE`
- `squash_merge_commit_message`: `PR_BODY`

Result:

- PR branches can contain multiple commits.
- `main` receives one squashed commit per merged PR.
- Merged remote branches are auto-deleted.

## Merge Strategy

Squash-merge only. All other merge strategies are disabled at the repository level.

## CI Gates

GitHub Actions workflow: `.github/workflows/ci.yml`

Required check before merge on `main`:

- `Lint, Build, Test`

That workflow runs:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm build`
- `pnpm test`

Manual/non-required checks:

- `pnpm test:parity:ts` for isolated TypeScript parity coverage when changing shared HTTP/API behavior
- `pnpm test:parity:rust` when validating Rust parity explicitly

## Recommended Ongoing Hygiene

1. Create short-lived feature branches from `main`.
2. Open PRs early; keep them focused.
3. Merge only with **Squash and merge** after the required GitHub check passes.
4. Periodically prune local branches:

```bash
git fetch --prune
git branch --merged main | grep -v ' main$' | xargs -n 1 git branch -d
```
