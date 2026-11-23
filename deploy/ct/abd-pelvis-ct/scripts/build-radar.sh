#!/bin/sh
set -eu

HERE="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TAG="${1:-dev}"

docker buildx build --network=host --platform linux/amd64 --load \
  -f "$HERE/gateway/Dockerfile" \
  -t "med-abd-pelvis-ct-gateway:${TAG}" \
  "$HERE/gateway"

docker buildx build --network=host --platform linux/amd64 --load \
  -f "$HERE/inference/Dockerfile" \
  --build-context hostpkgs=/usr/local/lib/python3.10/dist-packages \
  -t "med-abd-pelvis-ct-inference:${TAG}" \
  "$HERE/inference"
