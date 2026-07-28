#!/usr/bin/env python3
"""Fetch the CS2 depot key and a list of Steam cache hosts, once.

Everything else about chunk-level fetching is done in Node (see src/cs2Chunks.js): the
chunk objects are plain HTTPS GETs, the decryption is AES, and the payload is zstd, all
of which Node already has. Two things are not reachable that way, because they come over
Steam's own protocol rather than over HTTP:

  * the depot decryption key
  * the list of content servers to ask

Implementing that protocol would be days of work. Asking for it through the `steam`
package is two calls, and the answer barely changes: a depot key is rotated rarely, and
cache hosts are stable. So this runs by hand, writes the answer into the CS2 cache, and
Node reads it from there.

    pip install 'steam[client]'
    python3 scripts/cs2-depot-key.py tools/cs2

Anonymous, like every other Steam call in this project: no account, no copy of the game.

Deliberately not called from Node. A key that has gone stale is a thing to notice and
re-run, not something to paper over automatically on a production box that has no Python.
"""

import json
import sys
from pathlib import Path

APP_ID = 730
CONTENT_DEPOT = 2347770

# Enough that one host being slow or refusing a request is not fatal; src/cs2Chunks.js
# retries across them. There is no value in caching dozens.
HOSTS_WANTED = 6


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: cs2-depot-key.py <cs2 cache dir>", file=sys.stderr)
        return 2
    cs2_dir = Path(sys.argv[1])

    from steam.client import SteamClient
    from steam.client.cdn import CDNClient

    client = SteamClient()
    client.anonymous_login()
    cdn = CDNClient(client)

    key = cdn.get_depot_key(APP_ID, CONTENT_DEPOT)

    # `cdn.servers` holds ContentServer objects whose str() is the base URL.
    hosts = []
    for server in cdn.servers:
        url = str(server)
        start = url.find("'")
        end = url.find("'", start + 1)
        if start != -1 and end != -1:
            hosts.append(url[start + 1 : end])
        if len(hosts) >= HOSTS_WANTED:
            break

    cs2_dir.mkdir(parents=True, exist_ok=True)
    out = cs2_dir / "depot-access.json"
    out.write_text(
        json.dumps({"depotId": CONTENT_DEPOT, "key": key.hex(), "hosts": hosts}, indent=2)
        + "\n"
    )
    print(f"wrote {out} with {len(hosts)} cache host(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
