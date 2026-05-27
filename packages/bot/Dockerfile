# Bot image: builds the worker binaries first, then layers the TypeScript
# bot on top. The two binaries (`seed_worker`, `seed_precompute`,
# `seed_enrich`) end up in /usr/local/bin so the bot can spawn them.
#
# WORKER_BUILD selects the C compiler target (see packages/worker/Makefile).
# Default `native` enables -march=native + -flto for the host the docker
# build runs on. Override with --build-arg WORKER_BUILD=release for a
# portable image (e.g. cross-host CI -> registry workflows).

FROM ubuntu:24.04 AS worker-build
ARG WORKER_BUILD=native
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /worker
COPY packages/worker .
RUN make clean && make "${WORKER_BUILD}"

FROM node:20-bookworm AS bot-build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/bot/package.json packages/bot/
RUN npm install --workspaces --include-workspace-root --omit=optional
COPY packages/shared packages/shared
COPY packages/bot packages/bot
RUN npm run build --workspace=@kruto52/shared && \
    npm run build --workspace=@kruto52/bot

FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=worker-build /worker/seed_worker /worker/seed_precompute /worker/seed_enrich /usr/local/bin/
COPY --from=bot-build /app/package.json /app/package-lock.json* /app/tsconfig.base.json ./
COPY --from=bot-build /app/packages/shared/package.json packages/shared/package.json
COPY --from=bot-build /app/packages/shared/dist packages/shared/dist
COPY --from=bot-build /app/packages/bot/package.json packages/bot/package.json
COPY --from=bot-build /app/packages/bot/dist packages/bot/dist
COPY db db
RUN npm install --omit=dev --omit=optional --workspaces --include-workspace-root
ENV WORKER_BINARY=/usr/local/bin/seed_worker
ENV PRECOMPUTE_BINARY=/usr/local/bin/seed_precompute
ENV ENRICH_BINARY=/usr/local/bin/seed_enrich
ENV MIGRATIONS_DIR=/app/db/migrations
ENV NODE_ENV=production
CMD ["node", "packages/bot/dist/index.js"]
