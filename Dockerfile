# syntax=docker/dockerfile:1

FROM --platform=linux/amd64 node:24-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM --platform=linux/amd64 node:24-bookworm-slim@sha256:a09aabc645e86e81e23dab78e0c0f2eaa233cab4277c7188232181a1a8bd5d39 AS runtime

ARG VALVE_RESOURCE_FORMAT_VERSION=19.2
ARG VALVE_RESOURCE_FORMAT_SHA256=30d86dfd72bf35c8a38015c81bd92f0b04b1f49304e73a5d734c875803b2685b
# Borrows the map's sky out of the CS2 content depot, anonymously and one archive part
# at a time, so the image never needs a copy of the game. See src/cs2Content.js.
ARG DEPOT_DOWNLOADER_VERSION=3.4.0
ARG DEPOT_DOWNLOADER_SHA256=a999dec66b4850fc961bd50366696d23c2d0fad7b18790e6a5647b2f19097a53
# Steam publishes this archive at a mutable URL. A changed upstream archive must
# be reviewed and its checksum updated deliberately before an image can build.
ARG STEAMCMD_SHA256=cebf0046bfd08cf45da6bc094ae47aa39ebf4155e5ede41373b579b8f1071e7c

ENV NODE_ENV=production \
    PORT=8080 \
    TZ=Europe/Berlin \
    KZ_DATA_DIR=/data/catalog \
    KZ_MAPS_DIR=/data/maps \
    KZ_MODELS_DIR=/data/models \
    KZ_STATE_DIR=/data/state \
    KZ_TOOLS_DIR=/opt/kz-tools \
    KZ_CS2_DIR=/data/cs2

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
        xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && ln -snf /usr/share/zoneinfo/Europe/Berlin /etc/localtime \
    && echo Europe/Berlin > /etc/timezone \
    && mkdir -p /opt/steamcmd /opt/kz-tools \
    && curl --fail --location --proto '=https' --retry 3 --show-error --tlsv1.2 \
        https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz \
        --output /tmp/steamcmd_linux.tar.gz \
    && printf '%s  %s\n' "$STEAMCMD_SHA256" /tmp/steamcmd_linux.tar.gz \
        | sha256sum --check --strict - \
    && tar -tzf /tmp/steamcmd_linux.tar.gz > /dev/null \
    && tar -xzf /tmp/steamcmd_linux.tar.gz -C /opt/steamcmd \
    && printf '#!/bin/sh\nexec /opt/steamcmd/steamcmd.sh "$@"\n' \
        > /usr/local/bin/steamcmd \
    && chmod 0755 /usr/local/bin/steamcmd \
    && curl --fail --location --proto '=https' --retry 3 --show-error --tlsv1.2 \
        "https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/${VALVE_RESOURCE_FORMAT_VERSION}/cli-linux-x64.zip" \
        --output /tmp/valve-resource-format.zip \
    && printf '%s  %s\n' "$VALVE_RESOURCE_FORMAT_SHA256" /tmp/valve-resource-format.zip \
        | sha256sum --check --strict - \
    && unzip -tq /tmp/valve-resource-format.zip > /dev/null \
    && unzip -q /tmp/valve-resource-format.zip -d /opt/kz-tools \
    && chmod 0755 /opt/kz-tools/Source2Viewer-CLI \
    && curl --fail --location --proto '=https' --retry 3 --show-error --tlsv1.2 \
        "https://github.com/SteamRE/DepotDownloader/releases/download/DepotDownloader_${DEPOT_DOWNLOADER_VERSION}/DepotDownloader-linux-x64.zip" \
        --output /tmp/depotdownloader.zip \
    && printf '%s  %s\n' "$DEPOT_DOWNLOADER_SHA256" /tmp/depotdownloader.zip \
        | sha256sum --check --strict - \
    && unzip -tq /tmp/depotdownloader.zip > /dev/null \
    && unzip -q /tmp/depotdownloader.zip -d /opt/kz-tools \
    && chmod 0755 /opt/kz-tools/DepotDownloader \
    && rm -f /tmp/steamcmd_linux.tar.gz /tmp/valve-resource-format.zip /tmp/depotdownloader.zip \
    && chown -R node:node /opt/steamcmd /opt/kz-tools

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/viewer/public/data /opt/kz-seed/data
COPY --from=build --chown=node:node /app/viewer/public/maps /opt/kz-seed/maps
COPY --from=build --chown=node:node /app/LICENSE ./
COPY --from=build --chown=node:node /app/docs/third-party-notices.md ./THIRD_PARTY_NOTICES.md
COPY --chown=root:root deploy/entrypoint.sh /usr/local/bin/kz-replay-entrypoint

RUN chmod 0755 /usr/local/bin/kz-replay-entrypoint \
    && mkdir -p /data \
    && chown node:node /data

EXPOSE 8080

ENTRYPOINT ["kz-replay-entrypoint"]
CMD ["node", "server/index.js"]
