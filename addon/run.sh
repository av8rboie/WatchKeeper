#!/bin/sh
# Starts the backend. It reads the add-on options from /data/options.json
# (written by the Supervisor) and listens for ingress on 8099.
set -e
export DATA_DIR=/data
export HOST=0.0.0.0
export PORT=8099
exec node /app/server/dist/main.js
