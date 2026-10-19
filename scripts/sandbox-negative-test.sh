#!/usr/bin/env bash
# scripts/sandbox-negative-test.sh — 沙箱负向测试：尝试越界，确认被拒绝
set -euo pipefail

ROOT=/tmp/pd-sandbox
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')

while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      ROOT=$2
      shift 2
      ;;
    --platform)
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

echo "=== Sandbox Negative Tests ==="
echo "ROOT: $ROOT"
echo "PLATFORM: $PLATFORM"
echo ""

REPO=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$ROOT"
mkdir -p "$ROOT/users/1" "$ROOT/users/2" "$ROOT/system"
echo "secret" > "$ROOT/system/auth.db"
echo "other-user-data" > "$ROOT/users/2/secret.txt"

echo "TEST 1: read /root/.ssh (expect: permission denied)"
if bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --bind "$ROOT/users/1" "$ROOT/users/1" \
  --proc /proc \
  --dev /dev \
  --unshare-pid \
  --die-with-parent \
  /bin/sh -c "cat /root/.ssh/id_rsa 2>&1" | grep -q "Permission denied\|cannot open\|No such file"; then
  echo "  ✓ PASS: read /root/.ssh denied"
else
  echo "  ✗ FAIL: read /root/.ssh succeeded"
  exit 1
fi

echo "TEST 2: write ../users/2/ (expect: no such file or directory)"
if bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --bind "$ROOT/users/1" "$ROOT/users/1" \
  --proc /proc \
  --dev /dev \
  --unshare-pid \
  --die-with-parent \
  /bin/sh -c "cd '$ROOT/users/1' && echo hijack > ../2/hijack.txt 2>&1" | grep -q "No such file or directory\|cannot create"; then
  echo "  ✓ PASS: write ../users/2/ denied"
else
  echo "  ✗ FAIL: write ../users/2/ succeeded"
  exit 1
fi

echo "TEST 3: access <root>/system/auth.db (expect: no such file)"
if bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --bind "$ROOT/users/1" "$ROOT/users/1" \
  --proc /proc \
  --dev /dev \
  --unshare-pid \
  --die-with-parent \
  /bin/sh -c "cat '$ROOT/system/auth.db' 2>&1" | grep -q "No such file or directory\|cannot open"; then
  echo "  ✓ PASS: access system/auth.db denied"
else
  echo "  ✗ FAIL: access system/auth.db succeeded"
  exit 1
fi

rm -rf "$ROOT"
echo ""
echo "=== NEGATIVE TESTS PASS ==="
