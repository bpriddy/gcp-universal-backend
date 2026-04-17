#!/usr/bin/env bash
# Dev launcher for the GUB reference frontend (Vite demo).
# exec's `npm run dev` on port 5173.
#
# No DB, no .env required — this is a pure client that calls GUB's public API.
# Start GUB at http://localhost:3000 first, or use ../../stack.sh.

set -u
set -o pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PORT=5173

# ── Node 20 via nvm ───────────────────────────────────────────────────────
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use 20 >/dev/null 2>&1 || { echo "Node 20 not installed. Run: nvm install 20" >&2; exit 1; }
fi

# ── Port check ────────────────────────────────────────────────────────────
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Port $PORT already in use (needed for gub reference frontend)" >&2
  exit 1
fi

exec npm run dev
