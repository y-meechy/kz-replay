# Self-hosting

The production app is a Node server around the built Vite viewer. It serves static
files and generated catalogs, proxies replay downloads that browsers cannot request
directly, counts views, refreshes CS2KZ data nightly, and optionally converts missing
maps and the player model.

Before publishing an instance, read [the third-party notices](../THIRD_PARTY_NOTICES.md).
A local conversion can contain Workshop or Valve assets that are not covered by this
project's AGPL license.

## Run from a checkout

Install Node.js 24 LTS, then:

```bash
npm ci
npm run build
npm start
```

The server listens on port 8080 by default. This runs the viewer and replay proxy,
but automatic map and model conversion additionally needs the tools in
[maps.md](maps.md). Set `KZ_CONVERT_MAPS=false` when the host should refresh catalogs
without attempting geometry conversion.

Configuration comes from process environment variables. The application does not
automatically read `.env`; export values before starting it, use Node's
`--env-file=.env` option, or configure them in your service manager. See
[`../.env.example`](../.env.example) for the complete list.

Operational limits have conservative defaults and reject invalid values at startup:

| Variable                        | Default   | Purpose                                    |
| ------------------------------- | --------- | ------------------------------------------ |
| `KZ_TOOL_TIMEOUT_MINUTES`       | `30`      | Timeout per external tool process (1–1440) |
| `KZ_REPLAY_MAX_BYTES`           | `8000000` | Largest replay body accepted by the proxy  |
| `KZ_REPLAY_MAX_CONCURRENT`      | `8`       | Simultaneous upstream replay requests      |
| `KZ_REPLAY_REQUESTS_PER_MINUTE` | `60`      | Per-client replay requests in a minute     |

Keep `KZ_STATE_DIR` persistent because it contains view counts. Keep the generated
data, maps, models, tools, and CS2 cache persistent when you do not want refreshes or
conversions repeated after each deployment.

## Run the container

The Docker image includes the production server and conversion tools. Build and run
it with a persistent `/data` volume:

```bash
docker build -t kz-replay .
docker volume create kz-replay-data
docker run --name kz-replay \
  --publish 8080:8080 \
  --mount type=volume,src=kz-replay-data,dst=/data \
  --env TZ=Europe/Berlin \
  kz-replay
```

The image seeds catalog JSON into a new volume. Generated maps, models, CS2 content,
and view state then remain on that volume. Do not add locally generated assets to the
Docker build context unless you have reviewed their redistribution terms.

For a catalog-only deployment, add `--env KZ_CONVERT_MAPS=false`. The server exposes
`GET /healthz`; use it for container health checks and deploy coordination.

## Public deployment

Put a TLS-terminating reverse proxy or managed ingress in front of port 8080. Tune
the built-in replay limits above and apply request and bandwidth limits appropriate
to your host. Consider caching successful replay responses: a replay for a record id
is immutable. The application limits clients by the socket address and accepts
the first `X-Forwarded-For` address only when the direct peer is loopback or on a
private network. Make sure only a trusted reverse proxy can reach the application
on such a network, and set or replace that header at the proxy.

Back up the `/data/state` portion of the volume if view counts matter. Catalogs,
tracks, and converted assets can be rebuilt, but rebuilding can require network
downloads, external tools, substantial disk space, and mapper/game content rights.

The scheduled refresh uses the container's local time and defaults to 03:30. Set
`TZ`, `KZ_REFRESH_HOUR`, `KZ_REFRESH_MINUTE`, and `KZ_GEOMETRY_MINUTES` to match the
host's operations window. Monitor logs and `/healthz`; a healthy process can still
report a failed upstream refresh in its logs.
