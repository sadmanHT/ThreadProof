#!/usr/bin/env bash
set -euo pipefail

export SUPABASE_URL="${SUPABASE_URL:-https://mgxthhwzsvlxpsombydb.supabase.co}"
export NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-$SUPABASE_URL}"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:-sb_publishable_LdvioX_0DM6Dwlfwebfc0Q_XiM7VLfs}"
export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-sadmanHT/ThreadProof}"

if [[ -z "${SUPABASE_SECRET_KEY:-}" && -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo "Use Supabase Dashboard → Project Settings → API Keys → Secret key (sb_secret_...)"
  echo "or the legacy service_role key. Do NOT paste the publishable/anon key or database password."
  read -r -s -p "Paste the Supabase server key (input hidden): " SUPABASE_SERVICE_ROLE_KEY
  echo
  if [[ -z "$SUPABASE_SERVICE_ROLE_KEY" ]]; then
    echo "No Supabase server key was provided." >&2
    exit 1
  fi
  export SUPABASE_SERVICE_ROLE_KEY
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. GitHub Codespaces for this repository should provide it." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
  else
    echo "pnpm is unavailable and corepack was not found." >&2
    exit 1
  fi
fi

if [[ ! -d node_modules || ! -d apps/web/node_modules ]]; then
  pnpm install --frozen-lockfile
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required for automatic Actions-secret synchronization." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. In a GitHub Codespace it should normally be authenticated automatically." >&2
  exit 1
fi

npm run reset:e2e-users:sync

echo
echo "ThreadProof hosted E2E credentials are synchronized."
echo "The shared password was not printed or written to the repository."
