# syntax=docker/dockerfile:1
# Graphite web (Next.js, standalone output). Multi-stage, non-root.

FROM node:22.20.0-alpine3.22 AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@12.8.1 && pnpm --version

FROM base AS deps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY services/data/package.json services/data/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/chart-spec/package.json packages/chart-spec/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/storage/package.json packages/storage/
COPY packages/telemetry/package.json packages/telemetry/
# --ignore-scripts: postinstalls are not required (esbuild ships its
# binary via optional deps; see Phase 0 log). Matches the host setup.
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
WORKDIR /repo
COPY . .
RUN pnpm --filter @graphite/web build

FROM node:22.20.0-alpine3.22 AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
