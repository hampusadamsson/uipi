# Multi-stage build: pnpm workspace → server dist + web dist served by @uipi/server
FROM node:24-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# ---- build: full workspace (all package.json first for cacheable install) ----
FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/client/package.json packages/client/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm build

# ---- prod-deps: production-only dependency tree for the runtime image ----
FROM base AS prod-deps
WORKDIR /app
ENV NODE_ENV=production
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/client/package.json packages/client/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile --prod

# ---- pi-config: pinned snapshot of the user's pi agent dir (hampusadamsson/pi) ----
# The repo root is a near-exact snapshot of ~/.pi/agent. Fetched by SHA at build
# time (a plain `git clone --branch <sha>` does not work, so fetch + FETCH_HEAD).
# No auth.json there: the image intentionally ships no credentials.
FROM node:24-slim AS pi-config
ARG PI_CONFIG_REPO=https://github.com/hampusadamsson/pi.git
ARG PI_CONFIG_REF=256c9e672286bb1d265a173764bcdebfda75fd1b
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /pi-config
RUN git init -q \
  && git remote add origin "$PI_CONFIG_REPO" \
  && git fetch -q --depth 1 origin "$PI_CONFIG_REF" \
  && git checkout -q FETCH_HEAD
# settings.json holds machine-local macOS paths. The pi-web relays package is not
# installed in this image, so drop it entirely; any other opt/homebrew path is
# rewritten to its Linux equivalent.
RUN node -e '\
  const fs = require("fs");\
  const f = "settings.json";\
  const LINUX = "/usr/local/lib/node_modules/@jmfederico/pi-web/dist/pi-packages/relays";\
  const j = JSON.parse(fs.readFileSync(f, "utf8"));\
  if (Array.isArray(j.packages)) {\
    j.packages = j.packages\
      .filter((p) => !(typeof p === "string" && p.includes("@jmfederico/pi-web")))\
      .map((p) =>\
        typeof p === "string" && p.includes("opt/homebrew") ? LINUX : p);\
  }\
  if (j.extensionChangelogVersions) {\
    for (const k of Object.keys(j.extensionChangelogVersions))\
      if (k.includes("pi-web-access")) delete j.extensionChangelogVersions[k];\
  }\
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");\
' \
  && ! grep -q "opt/homebrew" settings.json \
  && ! grep -q "jmfederico" settings.json \
  && ! grep -q "pi-web-access" settings.json \
  && echo "pi-config: settings.json patched, no opt/homebrew, pi-web relays or stale changelog key left"
# sandbox.json is macOS-shaped: it denies /home (which covers this very agent
# dir), allowRead/allowWrite list /Users/hampus.adamsson/syncthing/... and
# "Library", and denyRead "/Users" contradicts those allowRead entries. Headless
# has no one to answer pi-sandbox's deny prompts, so the arrays must be coherent.
# The sandbox is also disabled outright because bwrap cannot create namespaces in
# this container under the default non-root user: probed failing with default
# seccomp, seccomp=unconfined, cap-add SYS_ADMIN and apparmor=unconfined. It works
# only as --privileged --user 0, which discards the non-root posture. socat (a
# sandbox-runtime dependency) is absent too. Re-enable only with a working bwrap.
RUN node -e '\
  const fs = require("fs");\
  const f = "sandbox.json";\
  const j = JSON.parse(fs.readFileSync(f, "utf8"));\
  const dropHost = (a) => a.filter((p) =>\
    typeof p !== "string" ||\
    !(p.includes("/Users/hampus.adamsson/syncthing") || p === "Library"));\
  const fs_ = j.filesystem || (j.filesystem = {});\
  fs_.denyRead = [".env", ".pem", "/Users"];\
  fs_.allowRead = dropHost(fs_.allowRead || [])\
    .concat(["/home/uipi/.pi/agent", "/workspace"]);\
  fs_.allowWrite = dropHost(fs_.allowWrite || []).concat("/workspace");\
  j.enabled = false;\
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");\
' \
  && ! grep -q "hampus.adamsson" sandbox.json \
  && ! grep -q '"Library"' sandbox.json \
  && echo "pi-config: sandbox.json patched for container paths"
# subagents.json carries the host's macOS pi path; point it at the bundled CLI.
RUN node -e '\
  const fs = require("fs");\
  const f = "subagents.json";\
  const j = JSON.parse(fs.readFileSync(f, "utf8"));\
  j.piBin = "/app/packages/server/node_modules/.bin/pi";\
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");\
' \
  && grep -q "/app/packages/server/node_modules/.bin/pi" subagents.json \
  && echo "pi-config: subagents.json piBin patched"

# ---- runtime ----
FROM node:24-slim AS runtime
# bindExtensions/removeWorkspaceDirs need git+node; gh for the github skill,
# bwrap+ripgrep for pi-sandbox, ca-certificates so git/npm can verify TLS;
# run as non-root on a writable HOME.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git ca-certificates ripgrep bubblewrap curl gnupg \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod 644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production UIPI_PORT=8787 UIPI_HOST=0.0.0.0
# New-session defaults (cwd for new sessions, pi's config dir); both are
# overridable at run time, e.g. `docker run -e UIPI_CWD=/app ...`.
ENV UIPI_CWD=/workspace UIPI_AGENT_DIR=/home/uipi/.pi/agent
# pi resolves its own agent dir from PI_CODING_AGENT_DIR, else ~/.pi/agent; pin it
# so pi subprocesses use the same dir as uipi regardless of HOME.
ENV PI_CODING_AGENT_DIR=/home/uipi/.pi/agent
# @uipi/protocol is type-only for the server, so it is deliberately not shipped.
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/package.json packages/server/package.json
COPY --from=build /app/packages/web/dist packages/web/dist
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/packages/server/node_modules packages/server/node_modules
# drop the dangling @uipi/protocol symlink: type-only dependency, not shipped
RUN rm -rf packages/server/node_modules/@uipi/protocol
RUN useradd -m uipi
# UIPI_CWD=/workspace and the server defaults to it, so it must exist and be
# writable by the non-root user or new sessions fail to start.
RUN mkdir -p /workspace && chown uipi:uipi /workspace
# Baked-in agent config (explicit allowlist; Dockerfile/.github/.pi/pi-web-access/
# dotfiles are deliberately not copied). chown'd so the non-root user can write
# recent-dirs.json, schedules.json, sessions/ and caches in place.
COPY --chown=uipi:uipi --from=pi-config \
  /pi-config/settings.json \
  /pi-config/APPEND_SYSTEM.md \
  /pi-config/roles.json \
  /pi-config/subagents.json \
  /pi-config/mcp.json \
  /pi-config/mcp-auth.json \
  /pi-config/mcp-onboarding.json \
  /pi-config/sandbox.json \
  /pi-config/zentui.json \
  /pi-config/web-search.json \
  /home/uipi/.pi/agent/
# NB: each dir is copied to its own named destination. Copying several source
# dirs to one destination would flatten their *contents* into the agent dir
# instead of creating subdirectories.
COPY --chown=uipi:uipi --from=pi-config /pi-config/roles      /home/uipi/.pi/agent/roles
COPY --chown=uipi:uipi --from=pi-config /pi-config/prompts    /home/uipi/.pi/agent/prompts
COPY --chown=uipi:uipi --from=pi-config /pi-config/skills     /home/uipi/.pi/agent/skills
COPY --chown=uipi:uipi --from=pi-config /pi-config/themes     /home/uipi/.pi/agent/themes
COPY --chown=uipi:uipi --from=pi-config /pi-config/extensions /home/uipi/.pi/agent/extensions
COPY --chown=uipi:uipi --from=pi-config /pi-config/git        /home/uipi/.pi/agent/git
COPY --chown=uipi:uipi --from=pi-config /pi-config/npm        /home/uipi/.pi/agent/npm
# uv/uvx for the uvx-based MCP servers (atlassian, humio).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
EXPOSE 8787
USER uipi
# Bake the settings.json packages now: otherwise they install lazily on the first
# session (slow, network-dependent). Runs as uipi so ~/.npm and the agent dir are
# populated with the right ownership.
RUN PATH="/app/packages/server/node_modules/.bin:$PATH" \
    PI_CODING_AGENT_DIR=/home/uipi/.pi/agent \
    HOME=/home/uipi \
    pi update --extensions
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]
