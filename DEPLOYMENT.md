# Production deployment

The production image is a Linux x64, Node 22 Debian container. It includes
SteamCMD and ValveResourceFormat CLI 19.2 for the nightly map conversion job.
Generated catalog files and finished maps persist on the host at
`/var/lib/kz-replay`; Steam Workshop downloads and conversion intermediates stay
inside the replaceable container.

The host nginx configuration for `preview-v2.kzcomp.com` already proxies to
`localhost:8081`. Docker publishes that port on loopback only.

## Build and start

Run these commands from the repository root on the deployment host:

```sh
sudo install -d -o 1000 -g 1000 /var/lib/kz-replay
docker compose -f docker-compose.prod.yml build --pull
docker compose -f docker-compose.prod.yml up -d --no-deps --scale kz-replay=1
```

Compose runs exactly one `kz-replay` container and restarts it unless it is
explicitly stopped. On the first start, bundled `viewer/public/data` and
`viewer/public/maps` are copied into the persistent volume. An existing target
directory is never overwritten.

## Inspect the service

Follow application and nightly refresh logs:

```sh
docker compose -f docker-compose.prod.yml logs -f --tail=200 kz-replay
```

Check the container and the loopback endpoint:

```sh
docker compose -f docker-compose.prod.yml ps
curl --fail --show-error http://127.0.0.1:8081/healthz
```

The health response is JSON and reports whether a refresh is running and the
result of the last refresh. Docker also checks `/healthz` inside the container
every 30 seconds.

## Deploy an update

Build the new image before replacing the running container:

```sh
docker compose -f docker-compose.prod.yml build --pull
docker compose -f docker-compose.prod.yml up -d --no-deps --scale kz-replay=1
docker compose -f docker-compose.prod.yml ps
curl --fail --show-error http://127.0.0.1:8081/healthz
```

The bind-mounted catalog and converted maps remain in
`/var/lib/kz-replay`. Do not scale the service above one instance: each instance
would schedule its own refresh job.

## Roll back

Before deploying, retain the currently running image under a rollback tag:

```sh
docker image tag kz-replay:latest kz-replay:rollback
```

If the new container is unhealthy, stop it, restore the previous tag, and start
one instance:

```sh
docker compose -f docker-compose.prod.yml down
docker image tag kz-replay:rollback kz-replay:latest
docker compose -f docker-compose.prod.yml up -d --no-deps --scale kz-replay=1
curl --fail --show-error http://127.0.0.1:8081/healthz
```

Rollback does not modify `/var/lib/kz-replay`. If data itself must be restored,
stop the service first and restore that directory from the host backup.
