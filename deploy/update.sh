#!/bin/bash
# Brings the server to origin/main: code, dependencies, schema, units, Caddy site — then
# restarts. Run as root on the server: `bash /opt/contentledger/app/deploy/update.sh`.
#
# The schema goes first: new code may read a table the old schema lacks, while old code
# ignores a table it does not know.
set -euo pipefail

APP=/opt/contentledger/app
SERVICES=(contentledger-fixtures contentledger-settler contentledger-gateway)

as_app() { sudo -u contentledger -H -- "$@"; }

cd "$APP"
as_app git fetch --quiet origin main
as_app git merge --ff-only --quiet origin/main
as_app pnpm install --frozen-lockfile --reporter=silent
echo "at $(as_app git rev-parse --short HEAD)"

# DDL needs session mode (5432); the variable lives only in this root-readable file.
(set -a; . /etc/contentledger/migrate.env; set +a
 cd packages/db && sudo -u contentledger -H --preserve-env=DATABASE_MIGRATION_URL -- \
   pnpm exec drizzle-kit migrate)

install -m 644 deploy/systemd/contentledger-*.service /etc/systemd/system/
install -m 644 -D deploy/Caddyfile /etc/caddy/sites/contentledger.caddy
systemctl daemon-reload
systemctl enable --quiet "${SERVICES[@]}"
caddy validate --config /etc/caddy/host.Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy

systemctl restart "${SERVICES[@]}"

# The settler reports after its first pass; /health is red until then.
for _ in $(seq 1 45); do
  if curl -fs -o /dev/null http://127.0.0.1:8879/health; then
    echo "gateway /health 200"
    exit 0
  fi
  sleep 2
done
echo "gateway /health not green after 90 s" >&2
curl -sS http://127.0.0.1:8879/health >&2 || true
journalctl -u contentledger-settler -u contentledger-gateway -n 30 --no-pager >&2
exit 1
