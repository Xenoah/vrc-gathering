#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$repo_root/extension/icons"
for size in 16 32 48 128; do
  magick "$repo_root/design/icon-source.png" -resize "${size}x${size}" -strip "$repo_root/extension/icons/icon-${size}.png"
done
