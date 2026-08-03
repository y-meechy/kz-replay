# Production deployment

The production image is a Linux x64, Node 22 Debian container. It includes
SteamCMD and ValveResourceFormat CLI 19.2 for the nightly map conversion job.
Generated catalog files, finished maps, the CT character and the view counter
persist on the host at `/var/lib/kz-replay`; Steam Workshop downloads and
conversion intermediates stay inside the replaceable container.

Of those four, the view counter (`/var/lib/kz-replay/state/views.json`) is the only
one that cannot be rebuilt from the CS2KZ API or out of CS2. Back that file up; the
rest is reproducible.

The host nginx configuration proxies the public domain to `localhost:8081`;
Docker publishes that port on loopback only.

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

## The CT character

The runner's body is `models/ct.glb`, borrowed out of CS2 rather than built from the
repository, so it is in no image. The server checks for it on every start and builds
it when it is not on the volume, which takes a few minutes of SteamCMD and the
exporter. Nothing waits for it: until it lands, the viewer draws its old white ball.

While that build runs, `/healthz` reports `refreshing: true`, so the deploy
script refuses to replace the container mid-conversion. That is also why
the character is built after the startup catalog refresh and never at the same time:
both jobs use the one CS2 asset cache in `/var/lib/kz-replay/cs2`.

To rebuild it by hand, delete it and restart, or run the job directly:

```sh
docker compose -f docker-compose.prod.yml exec kz-replay npm run player-model
```

That writes to `KZ_MODELS_DIR`, which compose points at `/data/models` on the
volume. Without that variable the file lands inside the container and the next
deploy throws it away.

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

The health response is JSON and reports whether a refresh is running, the result
of the last refresh, and how many runs and views the counter holds. Docker also
checks `/healthz` inside the container every 30 seconds.

## Automatic deployment

Pushing to `main` is the whole deployment procedure. The GitHub Actions
workflow (`.github/workflows/deploy.yml`) runs the tests, then connects to the
host over SSH and triggers `deploy/deploy.sh`, which tags the running image
`kz-replay:rollback`, pulls, builds, restarts, and waits for `/healthz`. A
build failure leaves the old commit and old container serving. A container
that never turns healthy is rolled back automatically. The `concurrency`
group keeps two pushes from deploying at once.

The key GitHub holds can only run the deploy script, nothing else. In the
deploy user's `~/.ssh/authorized_keys` on the host:

```
command="/opt/kz-replay/deploy/deploy.sh",restrict ssh-ed25519 AAAA... deploy@github-actions
```

Repository secrets the workflow needs (in the `production` environment):

- `DEPLOY_SSH_KEY` — the private half of that key, generated for this purpose
- `DEPLOY_HOST`, `DEPLOY_USER` — where to connect
- `DEPLOY_KNOWN_HOSTS` — output of `ssh-keyscan <host>`, so the connection
  cannot be silently redirected

The host itself still pulls with its own read-only deploy key at
`/root/.ssh/kz_replay_deploy`; the Actions key never carries repository
access.

Stop deployments without touching GitHub, which is what a long map
reconversion needs, because replacing the container mid-conversion throws the
work away:

```sh
touch /var/lib/kz-replay/.deploy-hold   # pause (the script fails loudly)
rm /var/lib/kz-replay/.deploy-hold      # resume, then re-run the workflow
```

The script also refuses any run where `/healthz` reports a refresh in
progress. A refused or failed run shows up red in the Actions tab; re-run it
from there once the host is quiet.

## Deploy an update by hand

Only needed when deployments are held or the workflow is broken. Build the new image before
replacing the running container:

```sh
docker compose -f docker-compose.prod.yml build --pull
docker compose -f docker-compose.prod.yml up -d --no-deps --scale kz-replay=1
docker compose -f docker-compose.prod.yml ps
curl --fail --show-error http://127.0.0.1:8081/healthz
```

The bind-mounted catalog, converted maps, character and view counts remain in
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
