FROM litestream/litestream:0.5.14-scratch AS litestream

FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json showdown.lock.json ./
COPY tools/setup-showdown.mjs tools/setup-showdown.mjs
RUN npm ci
RUN npm run setup:showdown

COPY tsconfig.json tsconfig.client.json vite.config.ts ./
COPY src src
COPY tools tools
COPY teams teams
RUN npm run build \
  && npm prune --omit=dev \
  && npm prune --omit=dev --omit=optional --prefix pokemon-showdown

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    VGC_LEAGUE_DATA_DIR=/data \
    VGC_LEAGUE_DB_PATH=/data/vgcleague.sqlite \
    VGC_LEAGUE_HOST=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/showdown.lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/teams ./teams
COPY --from=build --chown=node:node /app/pokemon-showdown/package.json ./pokemon-showdown/package.json
COPY --from=build --chown=node:node /app/pokemon-showdown/dist ./pokemon-showdown/dist
COPY --from=build --chown=node:node /app/pokemon-showdown/node_modules ./pokemon-showdown/node_modules

COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --chown=node:node litestream.yml ./litestream.yml
COPY --chown=node:node --chmod=755 tools/docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir /data && chown node:node /data
EXPOSE 3000

CMD ["/app/docker-entrypoint.sh"]
