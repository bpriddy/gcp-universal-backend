#!/usr/bin/env bash
# Dev launcher for gcp-universal-backend.
# Validates env + DB, then exec's `npm run dev` on port 3000.
#
# Runnable standalone: ./scripts/dev.sh
# Also invoked by the multi-repo orchestrator at ../stack.sh.

set -u
set -o pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PORT=3000

# ── Node 20 via nvm ───────────────────────────────────────────────────────
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use 20 >/dev/null 2>&1 || { echo "Node 20 not installed. Run: nvm install 20" >&2; exit 1; }
fi

# ── .env ──────────────────────────────────────────────────────────────────
[ -f .env ] || { echo ".env missing in $REPO_DIR" >&2; exit 1; }

# ── Postgres + DB probe (see: Postgres.app macOS permission gotcha) ───────
# `pg_isready` only tests the socket — Postgres.app gates `trust` auth
# behind a per-app macOS permission. Probe with a real query from this
# shell so child processes inherit the same permission.
DB_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"')
[ -n "$DB_URL" ] || { echo "DATABASE_URL missing from .env" >&2; exit 1; }

if ! out=$(psql "$DB_URL" -Atc 'SELECT 1' 2>&1); then
  echo "DB connect failed:" >&2
  echo "$out" >&2
  if printf '%s' "$out" | grep -q 'Postgres.app'; then
    echo "" >&2
    echo "Postgres.app is blocking this shell. Fix:" >&2
    echo "  Postgres.app → Preferences → Permissions → add Terminal/iTerm/zsh" >&2
    echo "Then restart Postgres.app and re-run." >&2
  fi
  exit 1
fi

# ── Pending Prisma migrations warning (non-fatal) ─────────────────────────
if command -v npx >/dev/null 2>&1; then
  if npx --no-install prisma migrate status 2>/dev/null | grep -q 'have not yet been applied'; then
    echo "⚠️  Pending Prisma migrations. Run: npx prisma migrate deploy" >&2
  fi
fi

# ── Port check ────────────────────────────────────────────────────────────
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Port $PORT already in use (needed for gcp-universal-backend)" >&2
  exit 1
fi

exec npm run dev
