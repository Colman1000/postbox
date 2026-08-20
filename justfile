# ─────────────────────────────────────────────────────────────────────────────
#  Postbox
#
#  just up     provision everything and deploy
#  just down   tear it all back down
#
#  Run `just` on its own for the full list.
# ─────────────────────────────────────────────────────────────────────────────

set positional-arguments := true

# Prefer bun when it is installed — it runs the TypeScript infra directly and
# installs several times faster — but never require it.
pm := if `command -v bun >/dev/null 2>&1 && echo yes || echo no` == "yes" { "bun" } else { "npm" }
run := if pm == "bun" { "bunx" } else { "npx" }

# Resource names come from infra/config.ts, so the CLI and the deploy can never
# disagree about what this stage's Worker or database is called.
names := "eval \"$(node infra/names.ts)\""

_default:
    @just --list --unsorted

# ── the two commands that matter ────────────────────────────────────────────

# Provision Cloudflare + Resend and deploy the app. Safe to re-run.
up: _preflight _install
    @{{run}} alchemy deploy ./alchemy.run.ts

# Destroy every resource this project created, including the Resend key.
down: _preflight _install
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(node infra/names.ts)"
    echo "This removes the Worker, D1 database, KV namespace, Email Routing rules,"
    echo "Resend DNS records, the Resend domain and the send-only API key."
    echo "Every message stored in ${POSTBOX_DB} is deleted and is not recoverable."
    printf "Type the domain (%s) to confirm: " "$POSTBOX_DOMAIN"
    read -r reply
    [ "$reply" = "$POSTBOX_DOMAIN" ] || { echo "Aborted."; exit 1; }
    {{run}} alchemy destroy ./alchemy.run.ts

# ── day to day ──────────────────────────────────────────────────────────────

# Run the UI and the Worker locally against real Cloudflare resources.
dev: _preflight _install
    @{{run}} alchemy dev ./alchemy.run.ts

# Stream live logs from the deployed Worker.
logs: _install
    @{{names}} && {{run}} wrangler tail "$POSTBOX_WORKER" --format pretty

# Type-check the whole project — UI, Worker and infra.
check: _install
    @{{run}} tsc -b

# Build the UI without deploying.
build: _install
    @{{pm}} run build

# ── setup helpers ───────────────────────────────────────────────────────────

# Store Cloudflare credentials once, instead of putting a token in .env.
login: _install
    @{{run}} alchemy login

# Mint a correctly-scoped Cloudflare API token interactively.
token: _install
    @{{run}} alchemy util create-cloudflare-token

# Check that the environment is complete before you try to deploy.
doctor: _preflight
    @node infra/doctor.ts

# Ask Resend to re-check DNS for your sending domain.
verify: _preflight
    @node infra/verify.ts

# Print where machine-local secrets are kept, and the UI password.
secrets: _preflight
    @node infra/secrets.ts

# ── data ────────────────────────────────────────────────────────────────────

# Run SQL against the live mail database. e.g. just sql "select count(*) from messages"
sql query: _install
    @{{names}} && {{run}} wrangler d1 execute "$POSTBOX_DB" --remote --command "{{query}}"

# Show recent send/receive activity straight from the database.
tail-mail: _install
    @{{names}} && {{run}} wrangler d1 execute "$POSTBOX_DB" --remote --command \
      "select datetime(created_at/1000,'unixepoch') as at, type, detail from events order by created_at desc limit 25"

# Remove build output and local caches. Leaves .secrets and .env alone.
clean:
    @rm -rf dist .wrangler node_modules/.tmp
    @echo "Removed dist/, .wrangler/ and the type-check cache."

# ── internals ───────────────────────────────────────────────────────────────

_preflight:
    @test -f .env || { \
      echo ""; \
      echo "  No .env found."; \
      echo ""; \
      echo "    cp .env.example .env"; \
      echo ""; \
      echo "  Then fill in DOMAIN, CLOUDFLARE_API_TOKEN and RESEND_API_KEY."; \
      echo ""; \
      exit 1; \
    }

_install:
    @test -d node_modules || { echo "Installing dependencies with {{pm}}…"; {{pm}} install; }
