#!/bin/sh
set -eu

# Cube's base image provides envd (49983) and the code-interpreter compatibility
# server (49999). Keep both available while Open-Inspect owns the foreground
# supervisor process.
/usr/local/bin/start-lightweight-code-interpreter.sh &
exec python /usr/local/bin/oi-launch
