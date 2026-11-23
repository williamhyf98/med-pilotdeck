#!/bin/sh
set -eu

TAG="${1:-dev}"
OUT="${2:-abd-pelvis-ct-images-${TAG}.tar.zst}"

docker save \
  "med-abd-pelvis-ct-gateway:${TAG}" \
  "med-abd-pelvis-ct-inference:${TAG}" \
  | zstd -T0 -3 >"$OUT"
sha256sum "$OUT" >"${OUT}.sha256"
printf 'created %s and %s\n' "$OUT" "${OUT}.sha256"
