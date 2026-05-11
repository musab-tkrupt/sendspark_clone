#!/usr/bin/env bash
# Render build script.
# In the Render dashboard set:
#   Root Directory  → backend
#   Build Command   → bash build.sh
set -euo pipefail

cd "$(dirname "$0")"
echo "[build] cwd: $(pwd)"

export PUPPETEER_CACHE_DIR="$(pwd)/.puppeteer_cache"
echo "[build] PUPPETEER_CACHE_DIR: $PUPPETEER_CACHE_DIR"

npm ci
pip install -r requirements.txt

echo "[build] chrome cache contents:"
ls "$PUPPETEER_CACHE_DIR" 2>/dev/null || echo "  (empty or missing)"
