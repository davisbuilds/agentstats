#!/usr/bin/env bash

set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh auth is not valid. Run: gh auth login -h github.com" >&2
  exit 1
fi

remote_url="$(git remote get-url origin)"

case "$remote_url" in
  https://github.com/*/*.git)
    repo="${remote_url#https://github.com/}"
    repo="${repo%.git}"
    ;;
  git@github.com:*/*.git)
    repo="${remote_url#git@github.com:}"
    repo="${repo%.git}"
    ;;
  *)
    echo "Unsupported origin remote: $remote_url" >&2
    exit 1
    ;;
esac

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/$repo/branches/main/protection" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Lint, Build, Test"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON

echo "Branch protection updated for $repo main"
