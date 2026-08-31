# Open-Inspect template for a self-hosted Tencent CubeSandbox backend.
#
# CubeSandbox supplies its E2B-compatible envd and code-interpreter services in
# sandbox-code. The rest of this file intentionally mirrors e2b.Dockerfile so
# both providers run the same pinned harnesses and sandbox runtime.

FROM ghcr.io/agent-infra/sandbox:1.11.0@sha256:6328d7fd2f0ff0b4c147c3d05b3df1ce331f4a482eb6e550ecd64ed1fcf906e7 AS aio-browser-source

FROM cube-sandbox-cn.tencentcloudcr.com/cube-sandbox/sandbox-code:latest

ARG OPENCODE_VERSION=1.18.18
ARG CODEX_VERSION=0.147.0
ARG CLAUDE_CODE_VERSION=2.1.233
ARG CLAUDE_AGENT_SDK_VERSION=0.2.139
ARG CODEWHALE_VERSION=0.9.8
ARG CODE_SERVER_VERSION=4.109.5
ARG AGENT_BROWSER_VERSION=0.21.2
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55

RUN apt-get update \
  && apt-get install -y git curl build-essential ca-certificates gnupg \
     openssh-client jq unzip libnss3 libnspr4 libatk1.0-0 \
     libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
     libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
     libpango-1.0-0 libcairo2 libatspi2.0-0 libavahi-client3 \
     fonts-liberation fonts-noto-color-emoji xdg-utils \
     ffmpeg xvfb fluxbox x11vnc websockify novnc \
     postgresql postgresql-client redis-server \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' \
     > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && npm install -g pnpm@latest \
  && BUN_INSTALL=/usr/local curl -fsSL https://bun.sh/install | bash \
  && python -m pip install --upgrade pip

RUN pip install --retries 10 --timeout 60 uv httpx websockets "pydantic>=2.0" "PyJWT[crypto]" \
    "claude-agent-sdk==${CLAUDE_AGENT_SDK_VERSION}" "mcp>=1.29.0,<2" "PyYAML>=6.0.2"

RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
  && npm install -g "@opencode-ai/plugin@${OPENCODE_VERSION}" zod \
  && npm install -g "@openai/codex@${CODEX_VERSION}" \
  && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm install -g "codewhale@${CODEWHALE_VERSION}" \
  && codex --version && claude --version && codewhale --version \
  && curl -fsSL -o /tmp/code-server.deb \
     "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb" \
  && dpkg -i /tmp/code-server.deb \
  && rm /tmp/code-server.deb \
  && curl -fsSL -o /usr/local/bin/ttyd \
     "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
  && echo "${TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c - \
  && chmod 0755 /usr/local/bin/ttyd \
  && npm install -g "agent-browser@${AGENT_BROWSER_VERSION}" \
  && agent-browser --version \
  && mkdir -p /workspace /app /tmp/opencode \
  && chmod 1777 /workspace /tmp/opencode

# Reuse only AIO Sandbox's browser runtime. Cube remains the VM/isolation base;
# AIO's duplicate Jupyter, code-server, terminal, and language stacks are not
# copied into the image.
COPY --from=aio-browser-source /opt/browser /opt/aio/browser
COPY --from=aio-browser-source /opt/fnm/node-versions/v22.23.0/installation/lib/node_modules/@agent-infra/mcp-server-browser /opt/aio/mcp-server-browser

RUN ln -s /opt/aio/mcp-server-browser/dist/index.cjs /usr/local/bin/aio-browser-mcp-server \
  && chmod 0755 /opt/aio/mcp-server-browser/dist/index.cjs \
  && /opt/aio/browser/chrome --version \
  && aio-browser-mcp-server --version \
  && ! ldd /opt/aio/browser/chrome | grep -q 'not found'

COPY sandbox_runtime /app/sandbox_runtime
COPY sandbox_runtime/gh-wrapper.sh /usr/local/bin/gh
COPY sandbox_runtime/bin/upload-media.js /usr/local/bin/upload-media
COPY sandbox_runtime/bin/oi-git-sign /usr/local/bin/oi-git-sign
COPY sandbox_runtime/bin/oi-visual-verify /usr/local/bin/oi-visual-verify
COPY oi-launch.py /usr/local/bin/oi-launch
COPY cube-health-server.py /usr/local/bin/oi-cube-health
COPY cube-entry.sh /usr/local/bin/cube-entry

RUN printf '/app\n' > "$(python -c 'import site; print(site.getsitepackages()[0])')/oi-app-path.pth" \
  && printf '%s\n' '#!/bin/sh' 'exec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"' \
     > /usr/local/bin/oi-git-credentials \
  && chmod 0755 /usr/local/bin/oi-git-credentials /usr/local/bin/gh \
     /usr/local/bin/upload-media /usr/local/bin/oi-git-sign \
     /usr/local/bin/oi-visual-verify \
     /usr/local/bin/oi-launch /usr/local/bin/oi-cube-health \
     /usr/local/bin/cube-entry \
  && test -x /usr/local/bin/upload-media \
  && test -x /usr/local/bin/oi-git-sign \
  && test -x /usr/local/bin/oi-visual-verify \
  && test -x /usr/local/bin/oi-cube-health \
  && git config --system credential.helper /usr/local/bin/oi-git-credentials \
  && git config --system credential.useHttpPath true

ENV HOME=/root \
    NODE_ENV=development \
    PATH=/usr/local/bin:/usr/bin:/bin \
    PYTHONPATH=/app \
    NODE_PATH=/usr/lib/node_modules \
    AIO_BROWSER_ENABLED=1 \
    AIO_BROWSER_EXECUTABLE_PATH=/opt/aio/browser/chrome \
    AIO_BROWSER_MCP_EXECUTABLE_PATH=/usr/local/bin/aio-browser-mcp-server \
    AGENT_BROWSER_AUTO_CONNECT=1 \
    AGENT_BROWSER_EXECUTABLE_PATH=/opt/aio/browser/chrome \
    SANDBOX_VERSION=v75-aio-browser

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/cube-entry"]
