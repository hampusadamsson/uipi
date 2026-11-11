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

# ---- runtime ----
FROM node:24-slim AS runtime
# bindExtensions/removeWorkspaceDirs need git+node; run as non-root on a writable HOME
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production UIPI_PORT=8787 UIPI_HOST=0.0.0.0
# New-session defaults (cwd for new sessions, pi's config dir); both are
# overridable at run time, e.g. `docker run -e UIPI_CWD=/app ...`.
ENV UIPI_CWD=/workspace UIPI_AGENT_DIR=/home/uipi/.pi/agent
# @uipi/protocol is type-only for the server, so it is deliberately not shipped.
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/package.json packages/server/package.json
COPY --from=build /app/packages/web/dist packages/web/dist
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/packages/server/node_modules packages/server/node_modules
# drop the dangling @uipi/protocol symlink: type-only dependency, not shipped
RUN rm -rf packages/server/node_modules/@uipi/protocol
EXPOSE 8787
RUN useradd -m uipi
USER uipi
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]
