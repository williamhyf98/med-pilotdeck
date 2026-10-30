#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
sha256sum -c SHA256SUMS
test -x python/3.10/bin/python3.10
test -x python/3.12/bin/python3.12
test -x deepchest/.venvs/radar/bin/python
test -x deepchest/.venvs/radar/bin/TotalSegmentator
echo "包内容校验通过"
