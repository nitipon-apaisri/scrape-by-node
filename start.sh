#!/bin/sh
set -eu

echo "scrape-by-node starting (PORT=${PORT:-3340}, DBD_HEADLESS=${DBD_HEADLESS:-false})"

if [ "${DBD_HEADLESS:-false}" = "false" ]; then
  exec xvfb-run --auto-servernum node dist/main.js
fi

exec node dist/main.js
