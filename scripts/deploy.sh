#!/bin/bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="/home/michael/gpsdash"

echo "Syncing ${SOURCE_DIR} to ${DEST_DIR}..."
sudo rsync -av --delete --chown=michael:michael \
  --exclude='.git' \
  --exclude='.DS_Store' \
  --exclude='node_modules' \
  --exclude='tests' \
  --exclude='test-results' \
  --exclude='playwright-report' \
  "${SOURCE_DIR}/" "${DEST_DIR}/"

echo "Installing production dependencies..."
sudo -u michael bash -c "cd '${DEST_DIR}' && npm ci --omit=dev"

echo "Restarting gpsdash service..."
sudo systemctl restart gpsdash

echo "Done."
