#!/usr/bin/env bash
# Build the official Stoat web client (stoatchat/for-web) for stoat-p2p.
#
# The client is built once with placeholder URLs; the node replaces them per
# request with its own address, so the same build works on any host/port.
#
#   npm run build:web                      # pinned, tested revision
#   STOAT_WEB_REF=main npm run build:web   # latest upstream
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${STOAT_WEB_REF:-494b73ea0e33db8fb77dd6966a1a0c6fd1b32e77}"
REPO="${STOAT_WEB_REPO:-https://github.com/stoatchat/for-web}"
WORK="$ROOT/web/.build"
OUT="$ROOT/web/dist"

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
if ! command -v pnpm >/dev/null; then
  echo "pnpm not found, enabling it through corepack"
  mkdir -p "$WORK/bin"
  corepack enable --install-directory "$WORK/bin"
  export PATH="$WORK/bin:$PATH"
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

if [ ! -d "$WORK/for-web/.git" ]; then
  mkdir -p "$WORK"
  git clone --filter=blob:none "$REPO" "$WORK/for-web"
fi
cd "$WORK/for-web"
git fetch --quiet origin "$REF" || git fetch --quiet origin
git checkout --quiet --force "$REF" 2>/dev/null || git checkout --quiet --force FETCH_HEAD
# Brand assets live on a private server; the client ships fallbacks.
git submodule update --init --depth 1 packages/stoat.js packages/solid-livekit-components

pnpm install --frozen-lockfile
pnpm --filter stoat.js build
pnpm --filter solid-livekit-components build
pnpm --filter client exec lingui compile --typescript
pnpm --filter client exec node scripts/copyAssets.mjs
pnpm --filter client exec panda codegen
pnpm --filter client exec lingui extract
pnpm --filter client exec lingui compile --typescript

VITE_HOST=__VITE_HOST__ \
VITE_API_URL=__VITE_API_URL__ \
VITE_DEV_WS_URL=__VITE_WS_URL__ \
VITE_DEV_MEDIA_URL=__VITE_MEDIA_URL__ \
VITE_DEV_PROXY_URL=__VITE_PROXY_URL__ \
VITE_DEV_GIFBOX_URL=__VITE_GIFBOX_URL__ \
VITE_RNNOISE_WORKLET_CDN_URL=__VITE_RNNOISE_WORKLET_CDN_URL__ \
BASE_PATH=/ \
  pnpm --filter client exec vite build

rm -rf "$OUT"
cp -r packages/client/dist "$OUT"
echo "Stoat web client ($(git rev-parse --short HEAD)) built into $OUT"
