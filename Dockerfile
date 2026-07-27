# syntax=docker/dockerfile:1

FROM --platform=linux/amd64 node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM --platform=linux/amd64 node:22-bookworm-slim AS runtime

ARG VALVE_RESOURCE_FORMAT_VERSION=19.2

ENV NODE_ENV=production \
    PORT=8080 \
    TZ=Europe/Berlin \
    KZ_DATA_DIR=/data/catalog \
    KZ_MAPS_DIR=/data/maps \
    KZ_TOOLS_DIR=/opt/kz-tools

# Copying the build output before installing runtime tools makes BuildKit finish
# the Vite stage first instead of running two memory-heavy stages concurrently.
WORKDIR /app
COPY --from=build --chown=node:node /app/viewer/dist ./viewer/dist

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        gosu \
        lib32gcc-s1 \
        libicu72 \
        tzdata \
        unzip \
    && rm -rf /var/lib/apt/lists/* \
    && ln -snf /usr/share/zoneinfo/Europe/Berlin /etc/localtime \
    && echo Europe/Berlin > /etc/timezone \
    && mkdir -p /opt/steamcmd /opt/kz-tools \
    && curl --fail --location --retry 3 \
        https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz \
        --output /tmp/steamcmd_linux.tar.gz \
    && tar -xzf /tmp/steamcmd_linux.tar.gz -C /opt/steamcmd \
    && printf '#!/bin/sh\nexec /opt/steamcmd/steamcmd.sh "$@"\n' \
        > /usr/local/bin/steamcmd \
    && chmod 0755 /usr/local/bin/steamcmd \
    && curl --fail --location --retry 3 \
        "https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/${VALVE_RESOURCE_FORMAT_VERSION}/cli-linux-x64.zip" \
        --output /tmp/valve-resource-format.zip \
    && unzip -q /tmp/valve-resource-format.zip -d /opt/kz-tools \
    && chmod 0755 /opt/kz-tools/Source2Viewer-CLI \
    && rm -f /tmp/steamcmd_linux.tar.gz /tmp/valve-resource-format.zip \
    && chown -R node:node /opt/steamcmd /opt/kz-tools

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/viewer/public/data /opt/kz-seed/data
COPY --from=build --chown=node:node /app/viewer/public/maps /opt/kz-seed/maps
COPY --chown=root:root deploy/entrypoint.sh /usr/local/bin/kz-replay-entrypoint

RUN chmod 0755 /usr/local/bin/kz-replay-entrypoint \
    && mkdir -p /data \
    && chown node:node /data

EXPOSE 8080

ENTRYPOINT ["kz-replay-entrypoint"]
CMD ["node", "server/index.js"]
