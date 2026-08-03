// Dev server endpoint that converts a map on demand.
//
// The conversion needs steamcmd, Source2Viewer-CLI and a few hundred megabytes of
// workshop download, so it can only ever run on the machine hosting the viewer, not
// in the browser. Exposing it as one endpoint means you never have to leave the page
// to get a map: the viewer notices the map is missing, you press Convert, and it
// appears. It is the same code path as `kzreplay map <name>`.

import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertMap } from "../src/mapPipeline.js";
import { fetchMap } from "../src/api.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Map names come from the API, but this endpoint runs shell commands with them, so
// it validates rather than trusts.
const SAFE_NAME = /^[A-Za-z0-9_]{1,64}$/;

const send = (response, status, body) => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
};

export const convertMapPlugin = () => ({
  name: "kz-convert-map",
  configureServer(server) {
    // One at a time: two steamcmd runs would fight over the same install directory.
    let running = null;

    server.middlewares.use("/api/convert-map", async (request, response) => {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        send(response, 405, { error: "use POST to convert a map" });
        return;
      }

      // A browser may reach a developer's loopback server from an unrelated page.
      // Require its Origin to name this Vite host before allowing a request that
      // downloads data and starts local executables. Requests without Origin remain
      // available to curl and other deliberate local tooling.
      const origin = request.headers.origin;
      if (origin) {
        let originHost = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          // An invalid Origin is never a same-origin request.
        }
        if (!originHost || originHost !== request.headers.host) {
          send(response, 403, {
            error: "cross-origin conversion is not allowed",
          });
          return;
        }
      }

      const url = new URL(request.url ?? "", "http://localhost");
      const name = url.searchParams.get("name") ?? "";

      if (!SAFE_NAME.test(name)) {
        send(response, 400, { error: "that is not a valid map name" });
        return;
      }
      if (running) {
        send(response, 409, { error: `already converting ${running}` });
        return;
      }

      running = name;
      const log = [];
      try {
        const map = await fetchMap(name);
        if (!map?.workshop_id) {
          throw new Error(`the CS2KZ API has no workshop id for ${name}`);
        }

        const { path } = await convertMap({
          mapName: map.name,
          workshopId: String(map.workshop_id),
          toolsDir: join(ROOT, "tools"),
          outputDir: join(ROOT, "viewer", "public", "maps"),
          // The same defaults the nightly job converts with, so a map converted from
          // the page does not come out looking different from the rest.
          withTextures: true,
          withColours: true,
          withLightmap: true,
          withSky: true,
          log: (message) => {
            log.push(message);
            server.config.logger.info(`[convert-map] ${name}: ${message}`);
          },
        });

        const { size } = await stat(path);
        send(response, 200, {
          ok: true,
          name: map.name,
          megabytes: +(size / 1e6).toFixed(1),
          mappers: (map.mappers ?? []).map((mapper) => mapper.name ?? mapper),
          log,
        });
      } catch (error) {
        server.config.logger.error(
          `[convert-map] ${name} failed: ${error.message}`,
        );
        send(response, 500, { error: error.message, log });
      } finally {
        running = null;
      }
    });
  },
});
