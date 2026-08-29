#!/usr/bin/env python3
"""
Open-Inspect E2B launcher — the template's start command.

E2B runs the template start command once at *build* time, snapshots it, and
resumes that process on every sandbox create; create-time env vars are NOT
visible to it (https://e2b.dev/docs/template/start-ready-command). The supervisor
needs per-session env (CONTROL_PLANE_URL, SESSION_CONFIG, auth token, clone token,
secrets), so the control plane drops those as a JSON file via envd's filesystem
API after create. This launcher waits for that file, loads it, and execs the
supervisor with the merged environment — so the supervisor starts fresh per
session regardless of E2B's snapshot/resume model.

On pause/resume the supervisor process itself is frozen/thawed by E2B, so this
launcher only runs for a fresh spawn.
"""

import http.client
import json
import os
import time

SESSION_ENV_PATH = "/tmp/oi-session.env"
CREATE_TIME_ENV_MARKER = "OI_USE_CREATE_TIME_ENV"
CREATE_TIME_ENV_CHUNKED_MARKER = "OI_E2B_ENV_CHUNKED"
CREATE_TIME_ENV_CHUNK_PREFIX = "OI_E2B_ENV_CHUNK_"
ENVD_HOST = "127.0.0.1"
ENVD_PORT = 49983
POLL_INTERVAL_SECONDS = 0.3
# Heartbeat log cadence while waiting for the session env file.
HEARTBEAT_EVERY = 100  # iterations (~30s at 0.3s)

# Static runtime env. The template start command inherits the Dockerfile's
# HOME=/root (needed by root at build), but E2B runs the sandbox as non-root
# `user`, so opencode/code-server must write under /home/user — otherwise they
# hit EACCES on /root/.local. PYTHONPATH/NODE_PATH aren't propagated by E2B.
STATIC_ENV = {
    "HOME": "/home/user" if os.getuid() != 0 else "/root",
    "PYTHONPATH": "/app",
    "NODE_PATH": "/usr/lib/node_modules",
}


def _log(msg: str) -> None:
    print(f"[oi-launch] {msg}", flush=True)


def _load_create_time_env() -> dict[str, str] | None:
    """Read CubeSandbox's create-time env after its snapshot has resumed."""
    connection = http.client.HTTPConnection(ENVD_HOST, ENVD_PORT, timeout=0.5)
    try:
        connection.request("GET", "/envs")
        response = connection.getresponse()
        if response.status != 200:
            return None
        parsed = json.loads(response.read(1024 * 1024))
    except (OSError, ValueError, http.client.HTTPException):
        return None
    finally:
        connection.close()
    if not isinstance(parsed, dict) or str(parsed.get(CREATE_TIME_ENV_MARKER, "")) != "1":
        return None
    return {str(k): str(v) for k, v in parsed.items()}


def _restore_chunked_env(environment: dict[str, str]) -> None:
    """Reassemble values split for CubeSandbox's create-time env limit."""
    chunk_keys = [key for key in environment if key.startswith(CREATE_TIME_ENV_CHUNK_PREFIX)]
    if not chunk_keys:
        environment.pop(CREATE_TIME_ENV_CHUNKED_MARKER, None)
        return

    chunks: dict[str, dict[int, str]] = {}
    for key in chunk_keys:
        suffix = key[len(CREATE_TIME_ENV_CHUNK_PREFIX) :]
        encoded_key, separator, raw_index = suffix.rpartition("_")
        if not separator or not encoded_key or not raw_index.isdigit():
            raise ValueError(f"malformed split environment key: {key}")
        try:
            original_key = bytes.fromhex(encoded_key).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as error:
            raise ValueError(f"malformed split environment key: {key}") from error
        index = int(raw_index)
        values = chunks.setdefault(original_key, {})
        if index in values:
            raise ValueError(f"duplicate split environment chunk: {key}")
        values[index] = environment[key]

    for original_key, indexed_chunks in chunks.items():
        indexes = sorted(indexed_chunks)
        if indexes != list(range(len(indexes))):
            raise ValueError(f"incomplete split environment value: {original_key}")
        environment[original_key] = "".join(indexed_chunks[index] for index in indexes)

    for key in chunk_keys:
        environment.pop(key, None)
    environment.pop(CREATE_TIME_ENV_CHUNKED_MARKER, None)


def main() -> None:
    # Poll indefinitely. E2B runs this start command once at build, snapshots it
    # mid-poll, and resumes it on each create — so a wall-clock deadline measured
    # here would be relative to *build* time and expire before any create. The
    # real bounds are E2B's sandbox TTL and the control plane's connecting-timeout
    # (which stops the sandbox if the bridge never phones home).
    use_create_time_env = os.environ.get(CREATE_TIME_ENV_MARKER) == "1"
    if use_create_time_env:
        _log("using create-time session environment")
        session_env = {}
    else:
        session_env = _load_create_time_env()
        if session_env is not None:
            _log(f"loaded {len(session_env)} create-time session vars from envd")
        else:
            _log(f"waiting for create-time env or session env at {SESSION_ENV_PATH}")
    i = 0
    while session_env is None:
        i += 1
        if i % HEARTBEAT_EVERY == 0:
            _log(f"still waiting for session env ({i} polls)")
        session_env = _load_create_time_env()
        if session_env is not None:
            _log(f"loaded {len(session_env)} create-time session vars from envd")
        elif os.path.exists(SESSION_ENV_PATH):
            # envd may materialize the upload non-atomically, so a read can race
            # the write and see a partial file. Treat any read/parse failure as
            # "not ready yet" and keep polling — the control plane's write is the
            # sole producer and converges to valid JSON.
            try:
                with open(SESSION_ENV_PATH, encoding="utf-8") as f:
                    parsed = json.load(f)
            except (OSError, ValueError) as e:
                _log(f"session env present but unreadable (partial write?): {e} — retrying")
            else:
                if isinstance(parsed, dict):
                    session_env = parsed
                else:
                    _log("session env is not a JSON object — retrying")
        time.sleep(POLL_INTERVAL_SECONDS)

    if not use_create_time_env:
        _restore_chunked_env(session_env)
    env = {**os.environ, **STATIC_ENV}
    if use_create_time_env:
        # Cube injects create-time variables into os.environ before starting
        # this launcher, so restore chunks after merging that layer.
        _restore_chunked_env(env)
    for k, v in session_env.items():
        env[str(k)] = str(v)

    _log(f"loaded {len(session_env)} session vars; starting supervisor")
    # E2B's `sandbox logs` does not surface the start command's stdout/stderr, so
    # mirror the supervisor's output to a file operators can tail for debugging.
    try:
        log_fd = os.open("/tmp/oi-supervisor.log", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        os.dup2(log_fd, 1)
        os.dup2(log_fd, 2)
        os.close(log_fd)
    except OSError as e:
        _log(f"could not redirect supervisor output: {e}")
    # Replace this process so the supervisor runs as the sandbox's main process.
    os.execvpe("python", ["python", "-m", "sandbox_runtime.entrypoint"], env)


if __name__ == "__main__":
    main()
