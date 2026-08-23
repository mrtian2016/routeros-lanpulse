#!/usr/bin/env bash
# Regenerate docs/demo/ from the demo instance.
#
# The demo instance is a normal lanpulse container pointed at a config whose display
# labels are generic and whose [redact] block is on — real data shapes, no real names.
# Keeping it separate from your own instance means the demo never picks up your
# hostnames or hardware models.
set -euo pipefail
DEMO_URL="${1:-http://10.0.0.8:9135}"
cd "$(dirname "$0")/.."
python3 scripts/make-demo.py "$DEMO_URL"
python3 scripts/leakscan.py docs/demo
echo
echo "Now: git add docs/demo && git commit && git push  (Pages redeploys automatically)"
