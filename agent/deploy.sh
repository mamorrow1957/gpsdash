#!/bin/bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="/home/michael/gpsdash-agent"

echo "Syncing ${SOURCE_DIR} to ${DEST_DIR}..."
sudo rsync -av --delete --chown=michael:michael \
  --exclude='.git' \
  "${SOURCE_DIR}/" "${DEST_DIR}/"

echo "Restarting gpsdash-agent service..."
sudo systemctl restart gpsdash-agent

echo "Done."
