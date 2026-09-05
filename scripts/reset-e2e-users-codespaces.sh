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

# Codespaces can expose a GitHub App/integration credential that is authenticated
# but is not allowed to read the Actions public key or write repository secrets.
# Preflight that exact permission before mutating Supabase so a failed sync cannot
# strand the four demo users on a generated password that CI never received.
if ! gh api "/repos/${GITHUB_REPOSITORY}/actions/secrets/public-key" >/dev/null 2>&1; then
  echo
  echo "GitHub CLI is authenticated, but this Codespace credential cannot write repository Actions secrets."
  echo "Automatic secret synchronization is unavailable in this environment."
  echo
  echo "We will use manual-safe recovery instead: choose one test-only password now,"
  echo "apply it to all four Supabase demo users, verify real login, then store that same"
  echo "value manually as GitHub Actions secret THREADPROOF_E2E_DEMO_PASSWORD."
  echo

  if [[ -z "${THREADPROOF_E2E_DEMO_PASSWORD:-}" ]]; then
    read -r -s -p "Choose a test-only E2E password (minimum 16 characters, input hidden): " manual_password
    echo
    read -r -s -p "Repeat the same E2E password: " manual_password_confirm
    echo

    if [[ ${#manual_password} -lt 16 ]]; then
      echo "The E2E password must be at least 16 characters." >&2
      exit 1
    fi
    if [[ "$manual_password" != "$manual_password_confirm" ]]; then
      echo "The two E2E password entries did not match; no Supabase users were changed." >&2
      exit 1
    fi

    export THREADPROOF_E2E_DEMO_PASSWORD="$manual_password"
    unset manual_password manual_password_confirm
  elif [[ ${#THREADPROOF_E2E_DEMO_PASSWORD} -lt 16 ]]; then
    echo "THREADPROOF_E2E_DEMO_PASSWORD must be at least 16 characters." >&2
    exit 1
  fi

  npm run reset:e2e-users

  echo
  echo "Supabase demo-user recovery succeeded, but GitHub Actions still needs the same password."
  echo "Open GitHub → sadmanHT/ThreadProof → Settings → Secrets and variables → Actions."
  echo "Create or update repository secret THREADPROOF_E2E_DEMO_PASSWORD with the exact"
  echo "test-only password you just entered. The password was not printed or committed."
  exit 0
fi

npm run reset:e2e-users:sync

echo
echo "ThreadProof hosted E2E credentials are synchronized."
echo "The shared password was not printed or written to the repository."
