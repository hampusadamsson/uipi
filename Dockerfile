# Multi-stage build: pnpm workspace → server dist + web dist served by @uipi/server
FROM node:26-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production UIPI_PORT=8787 UIPI_HOST=0.0.0.0
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/package.json packages/server/package.json
COPY --from=build /app/packages/web/dist packages/web/dist
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/server/node_modules packages/server/node_modules
COPY --from=build /app/packages/protocol/node_modules packages/protocol/node_modules
EXPOSE 8787
# bindExtensions/removeWorkspaceDirs need git+node; run as non-root on a writable HOME
RUN useradd -m uipi
USER uipi
CMD ["node", "packages/server/dist/main.js"]
