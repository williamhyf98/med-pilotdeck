#!/usr/bin/env bash
# scripts/smoke-multi-user.sh — isolated end-to-end smoke for the multi-user stack.
#
#   bash scripts/smoke-multi-user.sh [--root /tmp/pd-plan2] [--port 3151] [--gateway-base 19200] [--keep]
#
# Boots the real server on a throw-away PILOT_HOME with a seeded legacy layout, then
# checks: boot-time migration, A/B isolation, admin gating, key masking, revoke -> 4401,
# clean gateway shutdown, and no-login mode on the migrated root. Never touches
# .pilotdeck-home (its pilotdeck.yaml is only read, copied) and never binds the
# user's own stack ports. Every failed assertion exits non-zero with "SMOKE FAIL: ...".
# --keep leaves the root (logs, pid files, user homes) behind for inspection.
set -euo pipefail

ROOT=/tmp/pd-plan2; PORT=3151; GW=19200; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2;;
    --port) PORT=$2; shift 2;;
    --gateway-base) GW=$2; shift 2;;
    --keep) KEEP=1; shift;;
    *) echo "unknown arg $1" >&2; exit 1;;
  esac
done
REPO=$(cd "$(dirname "$0")/.." && pwd)
WAIT=60   # seconds for every wait loop
# Bookkeeping (logs, pid, ws markers) lives OUTSIDE the root: the boot-time migration
# archives unknown root entries, which would swallow server.pid/server.log.
RUN="$ROOT.run"

for reserved in 3020 5170 18800; do
  [ "$PORT" != "$reserved" ] && [ "$GW" != "$reserved" ] || { echo "refusing to use reserved port $reserved" >&2; exit 1; }
done
case "$ROOT" in "$REPO/.pilotdeck-home"*) echo "refusing to use .pilotdeck-home as the root" >&2; exit 1;; esac

STARTED=0
fail() { echo "SMOKE FAIL: $*"; exit 1; }
listener() { lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true; }
leftovers() { pgrep -f "$ROOT" 2>/dev/null | grep -vx "$$" | grep -vx "$PPID" || true; }

cleanup() {
  local rc=$?
  set +e
  if [ "$rc" -ne 0 ] && [ "$STARTED" = 1 ]; then
    for log in "$RUN"/server.log "$RUN"/server2.log; do
      [ -f "$log" ] && { echo "--- tail $log ---"; tail -n 25 "$log"; }
    done
  fi
  local l; l=$(listener); [ -n "$l" ] && kill -TERM "$l" 2>/dev/null
  [ -f "$RUN/server.pid" ] && kill -TERM "$(cat "$RUN/server.pid")" 2>/dev/null
  sleep 1
  l=$(leftovers); [ -n "$l" ] && { kill -TERM $l 2>/dev/null; sleep 1; l=$(leftovers); [ -n "$l" ] && kill -KILL $l 2>/dev/null; }
  l=$(listener); [ -n "$l" ] && kill -KILL "$l" 2>/dev/null
  if [ "$KEEP" = 1 ]; then echo "kept $ROOT (logs and pid in $RUN)"; else rm -rf "$ROOT" "$RUN"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

[ -z "$(listener)" ] || { echo "port $PORT is already in use" >&2; exit 1; }
[ -f "$REPO/.pilotdeck-home/pilotdeck.yaml" ] || { echo "missing $REPO/.pilotdeck-home/pilotdeck.yaml (needed for model config)" >&2; exit 1; }

rm -rf "$ROOT" "$RUN"; mkdir -p "$ROOT" "$RUN"
cp "$REPO/.pilotdeck-home/pilotdeck.yaml" "$ROOT/"
ln -s "$REPO/.pilotdeck-home/plugins" "$ROOT/plugins"
# seed a legacy layout so the boot-time migration is exercised
mkdir -p "$ROOT/projects/general_med/general_med-legacy1" "$ROOT/memory/global"
echo '{"type":"general_medicine","displayName":"旧病例"}' > "$ROOT/projects/general_med/general_med-legacy1/meta.json"

export PILOT_HOME="$ROOT" SERVER_PORT=$PORT PILOTDECK_GATEWAY_PORT_BASE=$GW PILOTDECK_DISABLE_LOCAL_AUTH=0 PILOTDECK_ADMIN_PASSWORD=adminpass

json() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1"; }
post() { curl -s -X POST "localhost:$PORT$1" -H 'content-type: application/json' ${3:+-H "Authorization: Bearer $3"} -d "$2"; }
get()  { curl -s "localhost:$PORT$1" -H "Authorization: Bearer $2"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

start_server() { # $1 = log file
  STARTED=1
  ( cd "$REPO" && nohup npm --prefix ui run dev:server > "$1" 2>&1 & echo $! > "$RUN/server.pid" )
  local i
  for i in $(seq 1 $WAIT); do curl -sf "localhost:$PORT/api/auth/status" >/dev/null && return 0; sleep 1; done
  fail "server did not come up within ${WAIT}s ($1)"
}
stop_server() {
  local l p; l=$(listener); p=$(cat "$RUN/server.pid")
  [ -n "$l" ] && kill -TERM "$l" 2>/dev/null || true
  kill -TERM "$p" 2>/dev/null || true
  local i
  for i in $(seq 1 $WAIT); do
    if [ -z "$(listener)" ] && ! kill -0 "$p" 2>/dev/null; then return 0; fi
    sleep 1
  done
  fail "server did not shut down within ${WAIT}s"
}

echo "== boot 1 (login mode) on $ROOT port $PORT gateway-base $GW"
start_server "$RUN/server.log"

ADM=$(post /api/auth/login '{"username":"admin","password":"adminpass"}' | json .token) || fail "admin login"
[ -n "$ADM" ] && [ "$ADM" != undefined ] || fail "admin login returned no token"
A=$(post /api/auth/register '{"username":"alice","password":"secret1"}' | json .token) || fail "register alice"
B=$(post /api/auth/register '{"username":"bob","password":"secret1"}' | json .token) || fail "register bob"
[ -n "$A" ] && [ "$A" != undefined ] || fail "alice registration returned no token"
[ -n "$B" ] && [ "$B" != undefined ] || fail "bob registration returned no token"

echo "== migration"
[ -f "$ROOT/system/migration/legacy-done.json" ] || fail "migration marker missing"
[ ! -d "$ROOT/projects" ] || fail "legacy projects/ still at root"
get /api/projects "$ADM" | grep -q '旧病例' || fail "admin cannot see migrated legacy project"
if get /api/projects "$A" | grep -q '旧病例'; then fail "alice can see admin's legacy project"; fi

echo "== isolation"
post /api/projects/create-system '{"displayName":"病例A","type":"general_medicine"}' "$A" >/dev/null
[ "$(ls "$ROOT/users/" | wc -l | tr -d ' ')" -ge 3 ] || fail "expected admin+alice+bob homes"
get /api/projects "$A" | grep -q '病例A' || fail "alice cannot see her own project"
if get /api/projects "$B" | grep -q '病例A'; then fail "bob can see alice's project"; fi
if get /api/projects "$ADM" | grep -q '病例A'; then fail "admin's list leaks alice's project"; fi

echo "== gating"
[ "$(code "localhost:$PORT/api/config" -H "Authorization: Bearer $A")" = 403 ] || fail "user reached /api/config"
[ "$(code "localhost:$PORT/api/config" -H "Authorization: Bearer $ADM")" = 200 ] || fail "admin blocked from /api/config"
if get /api/config "$ADM" | grep -q 'sk-'; then fail "api key leaked in /api/config"; fi

echo "== revoke closes sockets"
BOB_ID=$(get /api/admin/users "$ADM" | json ".users.find(u=>u.username==='bob').id") || fail "cannot read bob's id"
[ -n "$BOB_ID" ] && [ "$BOB_ID" != undefined ] || fail "bob's id not found"
node -e "
const WebSocket=require('$REPO/ui/node_modules/ws');const fs=require('fs');
const ws=new WebSocket('ws://localhost:$PORT/ws?token=$B');
ws.on('open',()=>fs.writeFileSync('$RUN/ws-open','1'));
ws.on('error',()=>{});
ws.on('close',(c)=>{fs.writeFileSync('$RUN/ws-close',String(c));process.exit(0)});
setTimeout(()=>process.exit(2),30000);" &
WSPID=$!
for i in $(seq 1 $((WAIT * 2))); do [ -f "$RUN/ws-open" ] && break; sleep 0.5; done
[ -f "$RUN/ws-open" ] || fail "bob's websocket never opened"
# the gateway pool spawns children on first authenticated request: record their pid file state
echo "pid file before shutdown: $(tr -d '\n ' < "$ROOT/system/gateway-pids.json" 2>/dev/null || echo missing)"
[ "$(code -X PATCH "localhost:$PORT/api/admin/users/$BOB_ID" -H "Authorization: Bearer $ADM" -H 'content-type: application/json' -d '{"isActive":false}')" = 200 ] || fail "deactivating bob failed"
for i in $(seq 1 $((WAIT * 2))); do [ -f "$RUN/ws-close" ] && break; sleep 0.5; done
wait "$WSPID" || true
[ "$(cat "$RUN/ws-close" 2>/dev/null)" = 4401 ] || fail "bob's socket not closed with 4401 (got '$(cat "$RUN/ws-close" 2>/dev/null)')"
[ "$(code "localhost:$PORT/api/projects" -H "Authorization: Bearer $B")" = 401 ] || fail "bob still authorized"

echo "== shutdown"
stop_server
[ -f "$ROOT/system/gateway-pids.json" ] || fail "pid file missing after shutdown"
[ "$(node -pe "Object.keys(JSON.parse(require('fs').readFileSync('$ROOT/system/gateway-pids.json','utf8'))).length")" = 0 ] || fail "pid file not empty after shutdown: $(cat "$ROOT/system/gateway-pids.json")"
echo "pid file after shutdown: $(tr -d '\n ' < "$ROOT/system/gateway-pids.json")"
[ -z "$(leftovers)" ] || fail "leftover gateway process: $(leftovers | tr '\n' ' ')"

echo "== boot 2 (no-login mode, same root)"
STARTED=1
# subshell: the unset must not leak into later steps
( unset PILOTDECK_DISABLE_LOCAL_AUTH; start_server "$RUN/server2.log"
  curl -s "localhost:$PORT/api/projects" | grep -q '旧病例' || fail "no-login mode does not show admin's projects" )
stop_server
[ -z "$(leftovers)" ] || fail "leftover process after second boot: $(leftovers | tr '\n' ' ')"
echo "SMOKE OK"
