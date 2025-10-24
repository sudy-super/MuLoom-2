#!/usr/bin/env bash
# Launch MuLoom controller UI (Vite) and Python engine concurrently.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
PYTHONPATH="$ROOT_DIR" \
  npx concurrently -k \
  "python -m engine.main --host 0.0.0.0 --port 8080" \
  "npm run dev --prefix $ROOT_DIR/app/ui"
