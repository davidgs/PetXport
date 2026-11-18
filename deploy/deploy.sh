#!/usr/bin/env bash
# Builds PetXport and installs it on the server over SSH: `pnpm deploy`.
#
# Settings come from deploy/deploy.conf (copy deploy/deploy.conf.example). The SSH login
# needs passwordless sudo. Nothing secret is sent: the server keeps its own .env, which
# this script never reads, overwrites or deletes.
#
# The first run stops after uploading, because the server has no .env yet; see
# "First deployment" in the README. Later runs upload, install dependencies, apply
# database changes and restart the service.
set -euo pipefail
cd "$(dirname "$0")/.."

CONF=deploy/deploy.conf
[ -f "$CONF" ] || { echo "Create $CONF from deploy/deploy.conf.example first." >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${DEPLOY_HOST:?set in $CONF}" "${DEPLOY_DIR:?set in $CONF}" "${DEPLOY_USER:?set in $CONF}" "${DEPLOY_PORT:?set in $CONF}"
NODE_BIN=${DEPLOY_NODE_BIN:-/usr/bin}
SERVICE=${DEPLOY_SERVICE:-petxport}

echo "==> Building"
rm -rf apps/api/dist apps/web/dist
pnpm install --frozen-lockfile >/dev/null
pnpm build >/dev/null

echo "==> Assembling release"
REL=$(mktemp -d)
trap 'rm -rf "$REL"' EXIT
mkdir -p "$REL/apps/api/src/db" "$REL/apps/web"
cp -R apps/api/dist apps/api/migrations "$REL/apps/api/"
cp apps/api/src/db/rls.sql "$REL/apps/api/src/db/"
cp -R apps/web/dist "$REL/apps/web/"
# The shared package is bundled into the server, so the server only needs the real dependencies.
node -e '
  const p = require("./apps/api/package.json");
  delete p.dependencies["@petxport/shared"];
  const out = { name: "petxport-server", private: true, type: "module", version: p.version, dependencies: p.dependencies };
  require("fs").writeFileSync(process.argv[1] + "/apps/api/package.json", JSON.stringify(out, null, 2) + "\n");
' "$REL"
git rev-parse --short HEAD 2>/dev/null > "$REL/REVISION" || date -u +%Y%m%dT%H%M%SZ > "$REL/REVISION"

echo "==> Uploading to $DEPLOY_HOST"
rsync -az --delete "$REL"/ "$DEPLOY_HOST:petxport-release/"

echo "==> Installing on the server"
ssh -o BatchMode=yes "$DEPLOY_HOST" bash -s -- "$DEPLOY_DIR" "$DEPLOY_USER" "$NODE_BIN" "$SERVICE" "$DEPLOY_PORT" <<'REMOTE'
set -euo pipefail
DIR=$1 RUN_AS=$2 NODE_BIN=$3 SERVICE=$4 PORT=$5
GROUP=$(id -gn "$RUN_AS")
sudo install -d -o "$RUN_AS" -g "$GROUP" -m 750 "$DIR"
# .env, its backups (.env.before-*) and installed packages live only on the server and are left alone.
sudo rsync -a --delete --exclude '/.env*' --exclude /apps/api/node_modules --exclude /apps/api/package-lock.json \
  --chown="$RUN_AS:$GROUP" "$HOME/petxport-release/" "$DIR/"
# Runs a command as the app's user, from a folder inside the app (which the SSH login itself may not be able to enter).
as_app() {
  local where=$1
  shift
  sudo -u "$RUN_AS" env HOME="$(getent passwd "$RUN_AS" | cut -d: -f6)" PATH="$NODE_BIN:/usr/bin:/bin" \
    sh -c 'cd "$0" && exec "$@"' "$where" "$@"
}
as_app "$DIR/apps/api" npm install --omit=dev --no-audit --no-fund --loglevel=error
if ! sudo test -f "$DIR/.env"; then
  echo
  echo "Uploaded, but $DIR/.env does not exist yet, so nothing was started."
  echo "Create it (see .env.example and the README's \"First deployment\"), then run this again."
  exit 3
fi
as_app "$DIR" env NODE_ENV=production node apps/api/dist/migrate.js
sudo systemctl restart "$SERVICE"
for i in $(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "Running: revision $(sudo cat "$DIR/REVISION")"
    exit 0
  fi
  sleep 0.5
done
echo "The service did not answer on port $PORT. Recent log:" >&2
sudo journalctl -u "$SERVICE" -n 25 --no-pager >&2
exit 1
REMOTE
