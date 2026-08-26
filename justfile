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
exec := if pm == "bun" { "bun run" } else { "node" }

# Always the versions pinned in package.json. `bunx alchemy` looks in
# node_modules first but silently downloads the newest release from npm when it
# does not find one there, which is how `just login` ended up running a version
# of Alchemy this project has never been tested against.
alchemy := exec + " ./node_modules/alchemy/bin/alchemy.js"
wrangler := exec + " ./node_modules/wrangler/bin/wrangler.js"

# Resource names come from infra/config.ts, so the CLI and the deploy can never
# disagree about what this stage's Worker or database is called.
names := "eval \"$(node infra/names.ts)\""

_default:
    @just --list --unsorted

# ── the two commands that matter ────────────────────────────────────────────

# Provision Cloudflare + Resend and deploy the app. Safe to re-run.
up: _preflight _install
    @{{alchemy}} deploy ./alchemy.run.ts

# Anything that was already there when Postbox arrived is left alone; `just
# down` prints which is which before it asks you to confirm.

# Destroy what this project created — and only that.
down: _preflight _install
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(node infra/names.ts)"
    node infra/teardown.ts plan
    printf "Type the domain (%s) to confirm: " "$POSTBOX_DOMAIN"
    read -r reply
    [ "$reply" = "$POSTBOX_DOMAIN" ] || { echo "Aborted."; exit 1; }
    # Drop the state for everything being kept, so the destroy cannot see it.
    node infra/teardown.ts forget
    {{alchemy}} destroy ./alchemy.run.ts
    # And put back the catch-all rule Postbox took over, if there was one.
    node infra/teardown.ts restore

# ── day to day ──────────────────────────────────────────────────────────────

# Run the UI and the Worker locally against real Cloudflare resources.
dev: _preflight _install
    @{{alchemy}} dev ./alchemy.run.ts

# Stream live logs from the deployed Worker.
logs: _install
    @{{names}} && {{wrangler}} tail "$POSTBOX_WORKER" --format pretty

# Type-check the whole project — UI, Worker and infra.
check: _install
    @./node_modules/.bin/tsc -b

# Build the UI without deploying.
build: _install
    @{{pm}} run build

# ── setup helpers ───────────────────────────────────────────────────────────

# Alchemy's own `login` only refreshes an account you have already chosen, so it
# is `configure` that belongs behind the command people run first: it signs in
# and then asks which account, which matters because most people have more than
# one and deploying into the wrong one is a mistake you discover much later.

# Sign in to Cloudflare and choose the account to deploy into.
login: _install
    @{{alchemy}} configure

# Refresh the sign-in for the account already chosen, without choosing again.
relogin: _install
    @{{alchemy}} login

# Mint a correctly-scoped Cloudflare API token — run `just login` first.
token: _install
    @{{alchemy}} util create-cloudflare-token

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
    @{{names}} && {{wrangler}} d1 execute "$POSTBOX_DB" --remote --command "{{query}}"

# Show recent send/receive activity straight from the database.
tail-mail: _install
    @{{names}} && {{wrangler}} d1 execute "$POSTBOX_DB" --remote --command \
      "select datetime(created_at/1000,'unixepoch') as at, type, detail from events order by created_at desc limit 25"

# Remove build output and local caches. Leaves .secrets and .env alone.
clean:
    @rm -rf dist .wrangler node_modules/.tmp
    @echo "Removed dist/, .wrangler/ and the type-check cache."

# ── internals ───────────────────────────────────────────────────────────────

# Two questions, in order: is there a .env at all, and does it say which
# Cloudflare account this is. The second one is asked rather than assumed —
# see infra/preflight.ts for why a token in the shell is not an answer.
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
    @node infra/preflight.ts

# A node_modules directory that exists is not the same as one that is complete:
# a half-finished or pre-alchemy install leaves the directory in place, and then
# every recipe below reaches for a binary that is not there.
_install:
    @test -f node_modules/alchemy/bin/alchemy.js && test -f node_modules/wrangler/bin/wrangler.js \
      || { echo "Installing dependencies with {{pm}}…"; {{pm}} install; }
