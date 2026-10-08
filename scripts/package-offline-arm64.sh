#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${1:-$ROOT/dist/offline}"
PACKAGE_NAME="${PILOTDECK_OFFLINE_PACKAGE_NAME:-med-pilotdeck-kylin-v10-arm64}"
IMAGE_NAME="${PILOTDECK_OFFLINE_IMAGE_NAME:-med-pilotdeck-offline-builder:arm64}"

command -v docker >/dev/null 2>&1 || {
  echo "error: Docker is required. Start Docker Desktop or provide a Docker Buildx host." >&2
  exit 1
}
docker buildx version >/dev/null 2>&1 || {
  echo "error: Docker Buildx is required." >&2
  exit 1
}

mkdir -p "$OUTPUT_DIR"
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/med-pilotdeck-offline.XXXXXX")"
trap 'rm -rf "$stage_dir"' EXIT

docker buildx build \
  --platform linux/arm64 \
  --file "$ROOT/packaging/offline-arm64.Dockerfile" \
  --tag "$IMAGE_NAME" \
  --output "type=local,dest=$stage_dir" \
  "$ROOT"

package_root="$stage_dir/$PACKAGE_NAME"
if [[ ! -d "$package_root" ]]; then
  # The scratch export is flattened by Buildx's local exporter. Put its
  # contents under the package directory before creating the archive.
  mkdir -p "$package_root"
  shopt -s dotglob nullglob
  for item in "$stage_dir"/*; do
    [[ "$item" == "$package_root" ]] && continue
    mv "$item" "$package_root/"
  done
  shopt -u dotglob nullglob
fi

if find "$package_root" -type f -name '*.pyc' -o -type f -name '*.tsbuildinfo' | grep -q .; then
  echo "error: generated package contains cache files" >&2
  exit 1
fi

tar_path="$OUTPUT_DIR/${PACKAGE_NAME}.tar.gz"
(
  cd "$stage_dir"
  tar -czf "$tar_path" "$(basename "$package_root")"
)
(
  cd "$OUTPUT_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$(basename "$tar_path")" > "$(basename "$tar_path").sha256"
  else
    shasum -a 256 "$(basename "$tar_path")" > "$(basename "$tar_path").sha256"
  fi
)

echo "created:"
echo "  $tar_path"
echo "  $tar_path.sha256"
du -h "$tar_path"
