# syntax=docker/dockerfile:1

# ---- Stage 1: build the official Stoat web client -------------------------
FROM node:24-bookworm AS web
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/build-web.sh scripts/build-web.sh
RUN mkdir -p web && bash scripts/build-web.sh && rm -rf web/.build

# ---- Stage 2: the node ------------------------------------------------------
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=web /app/web/dist ./web/dist

ENV STOAT_P2P_DATA=/data \
    STOAT_P2P_PORT=14702
VOLUME /data
EXPOSE 14702
CMD ["node", "src/cli.ts"]
