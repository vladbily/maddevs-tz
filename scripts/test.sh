#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_project="mesto-test-$$"

# Run Compose in a separate project with no published ports.
compose() {
  docker compose -p "$test_project" -f compose.test.yaml "$@"
}

# Remove only the containers and volumes created for this test run.
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    compose logs --tail=80 || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT

compose build backend frontend browser
compose up -d --wait postgres
compose run --rm backend sh -c \
  'uv run --no-sync ruff check . && uv run --no-sync ruff format --check . && uv run --no-sync alembic upgrade head && uv run --no-sync alembic check && uv run --no-sync pytest -q'
compose up -d --wait backend frontend
compose exec -T backend uv run --no-sync python -m tests.live_smoke
compose restart backend
compose up -d --wait backend frontend
compose exec -T backend uv run --no-sync python -m tests.live_smoke --after-restart
compose run --rm browser
