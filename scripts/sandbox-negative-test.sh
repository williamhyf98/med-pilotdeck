#!/usr/bin/env bash
# scripts/sandbox-negative-test.sh — 沙箱负向测试：尝试越界，确认被拒绝
set -euo pipefail

ROOT=
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')

while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      [ $# -ge 2 ] || { echo "--root requires a path" >&2; exit 1; }
      ROOT=$2
      shift 2
      ;;
    --platform)
      [ $# -ge 2 ] || { echo "--platform requires a value" >&2; exit 1; }
      PLATFORM=$2
      shift 2
      ;;
    *)
      echo "unknown arg $1" >&2
      exit 1
      ;;
  esac
done

if [ "$PLATFORM" != "linux" ]; then
  echo "SKIP: negative tests only run on Linux (platform: $PLATFORM)"
  exit 0
fi

REPO=$(cd -P "$(dirname "$0")/.." && pwd)
if [ -n "$ROOT" ]; then
  case "$ROOT" in /tmp/?*) ;; *) echo "--root must be under /tmp" >&2; exit 1 ;; esac
  case "$ROOT" in *..*|*'//'*) echo "--root must not contain '..' or '//'" >&2; exit 1 ;; esac
  TMP_ROOT=$(cd -P /tmp && pwd)
  ROOT_PARENT=$(cd -P "$(dirname "$ROOT")" && pwd) || { echo "--root parent must exist" >&2; exit 1; }
  case "$ROOT_PARENT" in "$TMP_ROOT"|"$TMP_ROOT"/*) ;; *) echo "--root parent resolves outside /tmp" >&2; exit 1 ;; esac
  case "$ROOT_PARENT" in "$REPO"|"$REPO"/*) echo "--root must not be inside the repo" >&2; exit 1 ;; esac
  if [ -e "$ROOT" ] || [ -L "$ROOT" ]; then
    echo "--root already exists; refusing to replace it: $ROOT" >&2
    exit 1
  fi
  mkdir -- "$ROOT"
else
  ROOT=$(mktemp -d /tmp/pd-sandbox.XXXXXX)
fi
trap 'rm -rf -- "$ROOT"' EXIT

echo "=== Sandbox Negative Tests ==="
echo "ROOT: $ROOT"
echo "PLATFORM: $PLATFORM"
echo ""

mkdir -p "$ROOT/users/1" "$ROOT/users/2" "$ROOT/system"
echo "secret" > "$ROOT/system/auth.db"
echo "other-user-data" > "$ROOT/users/2/secret.txt"
echo "owned-data" > "$ROOT/users/1/accessible.txt"

sandbox() {
  bwrap \
    --ro-bind /usr /usr \
    --ro-bind /lib /lib \
    --ro-bind /lib64 /lib64 \
    --ro-bind /bin /bin \
    --bind "$ROOT/users/1" "$ROOT/users/1" \
    --proc /proc \
    --dev /dev \
    --unshare-pid \
    --die-with-parent \
    "$@"
}

fail() { echo "  FAIL: $*" >&2; exit 1; }

echo "CONTROL: read own file (expect: owned-data)"
own_result=$(sandbox /bin/cat "$ROOT/users/1/accessible.txt" 2>&1) || fail "bwrap could not read own file: $own_result"
[ "$own_result" = owned-data ] || fail "own file read returned unexpected output: $own_result"

expect_denied() {
  local label=$1 pattern=$2 output
  shift 2
  echo "$label"
  if output=$(sandbox "$@" 2>&1); then
    fail "$label unexpectedly succeeded: $output"
  fi
  printf '%s\n' "$output" | grep -Eiq -- "$pattern" || fail "$label failed for a different reason: $output"
  echo "  PASS: access denied"
}

expect_denied "TEST 1: read /root/.ssh" \
  'Permission denied|cannot open|No such file' /bin/cat /root/.ssh/id_rsa
expect_denied "TEST 2: write ../users/2/" \
  'Permission denied|cannot create|No such file' \
  /bin/sh -c 'cd "$1" && printf hijack > ../2/hijack.txt' sh "$ROOT/users/1"
[ ! -e "$ROOT/users/2/hijack.txt" ] || fail "other user file was created"
expect_denied "TEST 3: access <root>/system/auth.db" \
  'Permission denied|cannot open|No such file' /bin/cat "$ROOT/system/auth.db"

echo ""
echo "=== NEGATIVE TESTS PASS ==="
