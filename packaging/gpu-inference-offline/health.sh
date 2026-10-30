#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/common.sh"
curl --fail-with-body --max-time 15 "http://127.0.0.1:$RADAR_PORT/health"
echo
curl --fail-with-body --max-time 15 "http://127.0.0.1:$DEEPCHEST_PORT/health"
echo
