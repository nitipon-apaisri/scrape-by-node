#!/bin/sh
set -eu

echo "scrape-by-node starting (PORT=${PORT:-3340}, DBD_HEADLESS=${DBD_HEADLESS:-false})"

if [ "${DBD_HEADLESS:-false}" = "false" ]; then
  echo "starting Xvfb virtual display on :99"
  Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
  export DISPLAY=:99
  sleep 1
fi

exec node dist/main.js
