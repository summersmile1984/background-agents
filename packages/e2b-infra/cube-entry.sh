#!/bin/sh
set -eu

# Cube's template probe is a hard lifecycle gate: if its port never becomes
# healthy, Cube terminates an otherwise healthy Open-Inspect supervisor. Keep
# that probe on a tiny first-party liveness server. The optional bundled code
# interpreter moves to an internal port so it cannot race the lifecycle probe;
# envd remains on 49983 for E2B compatibility.
python /usr/local/bin/oi-cube-health &
CODE_INTERPRETER_PORT=49998 /usr/local/bin/start-lightweight-code-interpreter.sh &

# Match managed E2B: the base sandbox stays inert until the control plane starts
# the supervisor through envd with the create-time environment.
exec sleep infinity
