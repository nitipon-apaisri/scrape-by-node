#!/bin/sh
set -eu

echo "scrape-by-node starting (PORT=${PORT:-3340}, DBD_HEADLESS=${DBD_HEADLESS:-false})"

if [ "${DBD_HEADLESS:-false}" = "false" ] && command -v xvfb-run >/dev/null 2>&1; then
  echo "launching with xvfb-run"
  exec xvfb-run --auto-servernum --server-args='-screen 0 1440x900x24' node dist/main.js
fi

echo "launching node directly"
exec node dist/main.js
