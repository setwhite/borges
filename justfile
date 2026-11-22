set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load

check: check-ts check-py

check-ts:
    pnpm exec biome check .
    pnpm --filter @borges/server exec tsc --noEmit
    pnpm exec depcruise apps/server/src --config .dependency-cruiser.cjs
    pnpm --filter @borges/server exec vitest run

check-py:
    cd workers/parser && uv run ruff check .
    cd workers/parser && uv run ruff format --check .
    cd workers/parser && uv run basedpyright
    cd workers/parser && uv run pytest

check-deadcode:
    pnpm exec knip
    cd workers/parser && uv run vulture src

parser-serve:
    cd workers/parser && uv run python -m borges_parser.app

db-up:
    docker compose up -d db

db-down:
    docker compose down

db-migrate:
    pnpm --filter @borges/server exec drizzle-kit migrate
