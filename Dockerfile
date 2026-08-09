FROM litestream/litestream:0.5.14-scratch AS litestream

FROM node:24.18.1-bookworm-slim AS build

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc showdown.lock.json ./
COPY tools/setup-showdown.mjs tools/setup-showdown.mjs
RUN npm install --global pnpm@11.11.0 --ignore-scripts --no-audit --no-fund \
  && pnpm install --frozen-lockfile \
  && pnpm run setup:showdown

COPY tsconfig.json tsconfig.client.json vite.config.ts ./
COPY src src
COPY tools tools
COPY teams teams
COPY boards boards
RUN pnpm run build \
  && pnpm prune --prod

FROM node:24.18.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    VGC_LEAGUE_DATA_DIR=/data \
    VGC_LEAGUE_DB_PATH=/data/vgcleague.sqlite \
    VGC_LEAGUE_HOST=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/showdown.lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/teams ./teams
COPY --from=build --chown=node:node /app/boards ./boards
COPY --chown=node:node artifacts/public/landing/circuit-trace-v1/manifest.json artifacts/public/landing/circuit-trace-v1/curated.json artifacts/public/landing/circuit-trace-v1/full.json ./artifacts/public/landing/circuit-trace-v1/
COPY --from=build --chown=node:node /app/pokemon-showdown/package.json ./pokemon-showdown/package.json
COPY --from=build --chown=node:node /app/pokemon-showdown/dist ./pokemon-showdown/dist
COPY --from=build --chown=node:node /app/pokemon-showdown/node_modules ./pokemon-showdown/node_modules

COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --chown=node:node litestream.yml ./litestream.yml
COPY --chown=node:node --chmod=755 tools/docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir /data && chown node:node /data
EXPOSE 3000

CMD ["/app/docker-entrypoint.sh"]
