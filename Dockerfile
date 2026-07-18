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
    VGC_LEAGUE_HOST=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/showdown.lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/teams ./teams
COPY --from=build --chown=node:node /app/pokemon-showdown/dist ./pokemon-showdown/dist
COPY --from=build --chown=node:node /app/pokemon-showdown/node_modules ./pokemon-showdown/node_modules

RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000

CMD ["node", "dist/src/cli.js", "gui"]
