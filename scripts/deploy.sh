#!/bin/bash
set -euo pipefail

echo "Installing production dependencies..."
cd /home/michael/gpsdash
npm ci --omit=dev

echo "Restarting gpsdash service..."
sudo systemctl restart gpsdash

echo "Done."
